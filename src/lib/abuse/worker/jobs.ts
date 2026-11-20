import { AbuseRepository } from "../repository";
import type { resolveAbuseTarget } from "../resolver";
import type { AbuseJob, AbuseJobType } from "../schema";
import { executeProviderSubmission, getProviderSubmissionProvider } from "../providers";
import type { JobClaimFilter } from "../persistence/jobs";
import { readSendEmailPayload, sendEmail } from "./email";
import { pollProviderCorrespondence } from "./correspondence";
import { findProviderReceipt } from "./receipt";
import { reportOriginHostJob } from "../origin/report";
import { analyzeKitSibling } from "../origin/kit_job";
import { watchRedirector } from "../origin/redirector_watch";
import { classifyReply, monitorProviderReply } from "./mail";
import { runGenericProviderPortal } from "./portal";
import { resolveReport } from "./resolution";
import { idFrom, parseJobBigInt, type WorkerServices } from "./shared";
import { boundedErrorText } from "../../util/error_text";
import { readInvestigationJobPayload } from "../../investigation/payload";
import { runReportInvestigation } from "../../investigation/run";
import { setInvestigationStatus } from "../../investigation/status";
import { followUpProviderDecision, readDecisionFollowUpPayload } from "../followup/decision";
import { describeCampaignIfChanged } from "../../campaign/link";
import { searchCampaignKits } from "../../campaign/kit_search";
import { linkSiteToCampaign } from "../../campaign/sweep";
import { runLivenessCheck } from "../../liveness/schedule";

/**
 * Jobs are claimed by lane, so one kind of slow work never starves another:
 *
 * - `control`: resolution and inbound correspondence keep capacity even when
 *   a provider browser or API call stalls. Read-only provider API calls sit
 *   here too, apart from browser and SMTP work.
 * - `external`: work that may cross an external provider side-effect
 *   boundary. Route verification and browser tasks can block for minutes, so
 *   they stay here rather than sharing the resolver slots.
 * - `sweep`: origin-host TLS sweeps run slice after slice for hours; one
 *   dedicated slot keeps them from occupying provider capacity and keeps the
 *   scan rate of the egress address bounded to one sweep at a time.
 * - `link`: linking a site into its campaign takes seconds; a slot of its own
 *   joins a site just reported at once instead of behind hours of discovery.
 * - `discovery`: searching a campaign's kit and the full browser analysis of
 *   each site it turns up, minutes each; a search queues up to a hundred.
 * - `liveness`: site checks run on their schedule after each report, hundreds
 *   a day, each on time instead of behind provider and browser work.
 */
export const JOB_LANES = ["control", "external", "sweep", "link", "discovery", "liveness"] as const;
export type JobLane = (typeof JOB_LANES)[number];

export type JobPolicy = {
	readonly lane: JobLane;
	/** Its failure never turns a submitted report into a reporting failure: the job just fails. */
	readonly supplementary: boolean;
	/** The deadline is at least this long, whatever the lane's. */
	readonly minTimeoutMs?: number;
};

const MINUTE = 60_000;

export const JOB_POLICY: Readonly<Record<AbuseJobType, JobPolicy>> = {
	resolve_report: { lane: "control", supplementary: false },
	monitor_provider_reply: { lane: "control", supplementary: false },
	classify_provider_reply: { lane: "control", supplementary: false },
	poll_provider_correspondence: { lane: "control", supplementary: false },
	find_provider_receipt: { lane: "control", supplementary: false },
	send_email: { lane: "external", supplementary: false },
	run_portal: { lane: "external", supplementary: false },
	submit_provider: { lane: "external", supplementary: false },
	// An investigation's work: payload downloads with their awaited public analyses, data-drop lookups, and the linked reports.
	// Evidence gathering must never keep a confirmed site from being reported.
	investigate_report: { lane: "external", supplementary: true, minTimeoutMs: 15 * MINUTE },
	// The agent may recheck and walk the site several times; one walk alone may take 20 minutes.
	follow_up_provider_decision: { lane: "external", supplementary: false, minTimeoutMs: 60 * MINUTE },
	watch_redirector: { lane: "external", supplementary: true },
	// Writes a campaign's public title and summary with the model.
	describe_campaign: { lane: "external", supplementary: true },
	report_origin_host: { lane: "sweep", supplementary: true },
	link_campaign: { lane: "link", supplementary: true },
	search_campaign_kits: { lane: "discovery", supplementary: true },
	analyze_kit_sibling: { lane: "discovery", supplementary: true },
	// One site check: DNS, RDAP, and a visit of up to nine requests of 15 seconds each.
	check_site_liveness: { lane: "liveness", supplementary: true },
};

const LIVENESS_TIMEOUT_MS = 5 * MINUTE;

/** The claim filter of a lane: exactly the job types the policy puts in it. */
export function laneFilter(lane: JobLane): JobClaimFilter {
	return { jobTypes: (Object.keys(JOB_POLICY) as AbuseJobType[]).filter((type) => JOB_POLICY[type].lane === lane) };
}

/** Jobs that may cross an external provider side-effect boundary. */
export const isExternalJob = (job: AbuseJob): boolean => JOB_POLICY[job.jobType].lane === "external";

/** The execution deadline of a job: its lane's, but never below its own minimum. */
export function jobTimeoutMs(jobType: AbuseJobType, lanes: { control: number; external: number; sweep: number }): number {
	const { lane, minTimeoutMs = 0 } = JOB_POLICY[jobType];
	const laneTimeout = lane === "control" ? lanes.control : lane === "sweep" ? lanes.sweep : lane === "liveness" ? LIVENESS_TIMEOUT_MS : lanes.external;
	return Math.max(laneTimeout, minTimeoutMs);
}

type JobContext = {
	signal?: AbortSignal;
	services: WorkerServices;
	resolveTarget: typeof resolveAbuseTarget;
	investigateReport: typeof runReportInvestigation;
};

type JobHandler = (job: AbuseJob, context: JobContext) => Promise<unknown>;

async function runInvestigationJob(job: AbuseJob, { signal, investigateReport }: JobContext): Promise<void> {
	const reportId = idFrom(job.reportId, "reportId");
	const report = await AbuseRepository.getReport(reportId);
	if (!report?.submissionId) return;
	const payload = readInvestigationJobPayload(job.payload);
	try {
		await investigateReport({
			reportId,
			payload,
			reporter: {
				reporterIp: report.requesterIp ?? undefined,
				reporterCountry: report.requesterCountry ?? undefined,
				reporterHeaders: report.requesterHeaders ?? undefined,
			},
			...(signal ? { signal } : {}),
		});
	} catch (error) {
		// The worker decides finality: a retryable failure is queued again, and a
		// terminal one releases the report on its single terminal path.
		await setInvestigationStatus(report.submissionId, { status: "queued", lastError: boundedErrorText(error), updatedAt: new Date().toISOString() });
		throw error;
	}
}

async function runPortal(job: AbuseJob, { services }: JobContext): Promise<void> {
	const routeId = idFrom(job.routeId, "routeId");
	const route = await AbuseRepository.getRoute(routeId);
	if (!route) throw new Error("Abuse route no longer exists.");
	if (route.routeType === "email") {
		await runGenericProviderPortal(routeId, job.payload ?? {}, services);
		return;
	}
	throw new Error(`No code-owned portal adapter is available for abuse route ${route.id.toString()}.`);
}

/** Dispatch a direct submission exclusively through the provider registry. */
async function submitProvider(job: AbuseJob, { signal }: JobContext): Promise<void> {
	const route = await AbuseRepository.getRoute(idFrom(job.routeId, "routeId"));
	if (!route || route.routeType !== "provider_submission") return;
	const provider = getProviderSubmissionProvider(route.providerRegistryKey);
	if (!provider) {
		await AbuseRepository.transitionRouteStatus({
			routeId: route.id,
			from: ["verified", "queued", "running"],
			to: "needs_human",
			data: { reason: "provider_submission_implementation_missing" },
		});
		return;
	}
	await executeProviderSubmission({ routeId: route.id, provider, signal });
}

export const JOB_HANDLERS: Readonly<Record<AbuseJobType, JobHandler>> = {
	resolve_report: (job, { resolveTarget }) => resolveReport(idFrom(job.reportId, "reportId"), resolveTarget, job.retryCount),
	send_email: (job, { services }) => sendEmail(idFrom(job.routeId, "routeId"), services, readSendEmailPayload(job.payload)),
	run_portal: runPortal,
	submit_provider: submitProvider,
	classify_provider_reply: (job) => classifyReply(parseJobBigInt(job.payload?.messageId, "payload.messageId")),
	poll_provider_correspondence: (job, { signal }) => pollProviderCorrespondence({ routeId: idFrom(job.routeId, "routeId"), jobId: job.id, signal }),
	find_provider_receipt: (job, { signal }) => findProviderReceipt({ runId: idFrom(job.runId, "runId"), jobId: job.id, signal }),
	monitor_provider_reply: (job) => monitorProviderReply(idFrom(job.routeId, "routeId")),
	investigate_report: runInvestigationJob,
	follow_up_provider_decision: (job, { signal }) => followUpProviderDecision({ routeId: idFrom(job.routeId, "routeId"), ...readDecisionFollowUpPayload(job.payload) }, signal ? { signal } : {}),
	report_origin_host: (job, { signal }) => reportOriginHostJob(job, idFrom(job.reportId, "reportId"), signal),
	search_campaign_kits: (job, { signal }) => searchCampaignKits({ job, signal }),
	analyze_kit_sibling: (job, { signal }) => analyzeKitSibling({ reportId: idFrom(job.reportId, "reportId"), url: job.payload?.url, hashes: job.payload?.hashes, signal }),
	watch_redirector: (job, { signal }) => watchRedirector({ job, signal }),
	link_campaign: (job) => linkSiteToCampaign({ submissionId: parseJobBigInt(job.payload?.submissionId, "payload.submissionId"), reportId: idFrom(job.reportId, "reportId") }),
	describe_campaign: (job) => describeCampaignIfChanged(parseJobBigInt(job.payload?.campaignId, "payload.campaignId")),
	check_site_liveness: (job, { signal }) => runLivenessCheck({ jobId: job.id, targetId: parseJobBigInt(job.payload?.targetId, "payload.targetId"), dependencies: signal ? { signal } : {} }),
};

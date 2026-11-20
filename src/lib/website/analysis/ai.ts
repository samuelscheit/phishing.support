import { reporterBrowserIdentity } from "../../browser/reporter_identity";
import { archiveWebsite } from "../archive";
import type { ArchiveWebsiteOptions, WebsitePageSession, WebsiteVerificationGate } from "../archive/types";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import { getInfo } from "../info/info";
import { runStreamedAnalysisRun } from "../../analysis/run";
import { reportConfirmedWebsiteAbuse } from "../../abuse/submission_reports";
import type { ReporterMetadata } from "../../http/reporter_headers";
import { defaultReasoning, defaultResponseModel } from "../../openai/client";
import { analyzedCaptureStep } from "../visit/capture_files";
import { extractPasteCommands } from "../../malware/paste_commands";
import { isSameWebsite, websiteSite } from "../info/site";
import { accessGateOf, arrivalChain, checkBareVisit, type BareVisitDependencies } from "../visit/access_gate";
import { abuseEmailCaseUrl } from "../../abuse/mail/draft";
import { buildWebsiteAnalysisInput } from "./narrative";
import { buildWebsiteReportEvidence, classifiedHiddenFrame } from "./classification";
import type { WebsiteDevice, WebsiteHiddenFrame, WebsiteKitResource, WebsiteNavigationHop } from "../types";
import { emitStep } from "../visit/progress";
import { capturedArchiveHop, reportableFinding, reportableWebsiteHop, unreportedVerdict, websiteReportUrls } from "../info/report_hops";
import { capturedPageScreenshots, capturedWebsiteData, websiteEvidence } from "./evidence";
import { visitWebsite } from "../visit/visit";
import { cloakedDestinationInfo, cloakingSuspectedInfo, handOffRedirectedCapture, settleCloakedRedirectsTo } from "../visit/cloaked_redirect";
import { BROWSER_BACKOFF_MS, failWebsiteAnalysis, recordWebsiteAnalysisFailure, withBrowserBackoff } from "./failure";
import type { WebsiteAnalysisDependencies, WebsiteCapture } from "./analysis_types";

export type AnalyzeWebsiteOptions = {
	mhtmlSnapshot?: Buffer;
	/** Original captured document URL for retained MHTML, distinct from its submitted URL. */
	archivedUrl?: string;
	/** Original response-by-response provenance for retained MHTML. */
	navigationHops?: WebsiteNavigationHop[];
	/** Set only when MHTML was loaded from this submission's internally archived artifact. */
	trustMhtmlDocumentLocation?: boolean;
	/** Existing evidence screenshot used when a retry parses MHTML locally. */
	screenshotSnapshot?: Buffer;
	/** The network route the original live capture of retained MHTML used. */
	captureRoute?: string;
	/** The verification gate retained MHTML was captured behind. */
	verificationGate?: WebsiteVerificationGate;
	/** Same-host scripts and stylesheets the original live capture of retained MHTML received. */
	kitResources?: WebsiteKitResource[];
	/** Hidden frames the original live capture of retained MHTML recorded. */
	hiddenFrames?: WebsiteHiddenFrame[];
	/** The phone the original live capture of retained MHTML presented. */
	device?: WebsiteDevice;
	/** Reuse the existing website archive artifacts instead of writing duplicates. */
	reuseEvidenceArtifacts?: boolean;
	url: string;
	submissionId: bigint;
} & ReporterMetadata;

export async function analyzeWebsite(options: AnalyzeWebsiteOptions, dependencies: WebsiteAnalysisDependencies = {}): Promise<bigint> {
	const analyze = (nextOptions: AnalyzeWebsiteOptions) => analyzeWebsite(nextOptions, dependencies);
	const { url, submissionId, reporterIp, reporterCountry, reporterHeaders, reuseEvidenceArtifacts = false } = options;
	// Every live capture keeps its browser open for the flow's next action on
	// the page; each one is closed once the flow is done with it.
	const sessions: WebsitePageSession[] = [];
	// Automatic retries already spent on this case; the run's own data writes drop the record.
	let priorAttempts = 0;
	const closeSessions = () => Promise.all(sessions.splice(0).map((session) => session.close().catch((error: unknown) => console.warn("Closing a capture browser failed:", error))));
	// Every live capture of the case, the visit's included, presents the reporter's own browser.
	const visitor = reporterBrowserIdentity(reporterHeaders);
	const capture = async (captureOptions: ArchiveWebsiteOptions) => {
		const captured = await withBrowserBackoff(() => (dependencies.archiveWebsite ?? archiveWebsite)({ ...captureOptions, ...(visitor ? { visitor } : {}), keepSession: true }), dependencies.browserBackoffMs ?? BROWSER_BACKOFF_MS);
		if (captured.session) sessions.push(captured.session);
		return captured;
	};
	try {
		const prior = await SubmissionsEntity.get(submissionId);
		priorAttempts = (prior?.data.kind === "website" && prior.data.website.autoRetry?.attempts) || 0;
		// Claim the submission before any network work: while the row still says
		// `new`, a restart during the first lookup would leave it looking queued
		// forever with no retry path.
		await SubmissionsEntity.update(submissionId, { status: "running", info: "Collecting bounded WHOIS, RDAP, and regional DNS evidence." });
		await emitStep(submissionId, "whois_lookup", 5);
		const whois = await (dependencies.getInfo ?? getInfo)(url);

		await SubmissionsEntity.update(submissionId, {
			status: "running",
			info: undefined,
			data: { kind: "website", website: { url, whois } },
		});

		await emitStep(submissionId, "archive_website", 10);
		const captured = await capture({
			url,
			mhtmlSnapshot: options.mhtmlSnapshot,
			archivedUrl: options.archivedUrl,
			navigationHops: options.navigationHops,
			trustMhtmlDocumentLocation: options.trustMhtmlDocumentLocation,
			verificationGate: options.verificationGate,
			kitResources: options.kitResources,
			hiddenFrames: options.hiddenFrames,
			device: options.device,
		});
		let archive: WebsiteCapture = {
			...captured,
			...(!captured.screenshotPng && options.screenshotSnapshot ? { screenshotPng: options.screenshotSnapshot } : {}),
			...(!captured.route && options.captureRoute ? { route: options.captureRoute } : {}),
		};
		if (archive.cloaking?.outcome === "unresolved") {
			// The capture holds only the decoy every reachable route was shown. It
			// is neither evidence against the submitted site nor a case of its own.
			await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await websiteEvidence(submissionId, url, archive, dependencies) });
			await SubmissionsEntity.update(submissionId, {
				status: "failed",
				info: cloakingSuspectedInfo(archive.cloaking),
				data: { kind: "website", website: { url, whois, archiveUrl: archive.url, navigationHops: archive.navigationHops, cloaking: archive.cloaking } },
			});
			await emitStep(submissionId, "failed", 100);
			return submissionId;
		}
		let capturedHop = archive.attributionError ? undefined : capturedArchiveHop(archive);
		if (capturedHop && !isSameWebsite(capturedHop.url, url)) {
			await handOffRedirectedCapture({ submissionId, url, whois, archive, capturedHop, reporter: { reporterIp, reporterCountry, reporterHeaders }, dependencies, analyze });
			await emitStep(submissionId, "completed", 100);
			return submissionId;
		}

		await emitStep(submissionId, "save_artifacts", 40);
		// A retry that reuses the stored capture keeps its original evidence package.
		if (!reuseEvidenceArtifacts) {
			await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await websiteEvidence(submissionId, url, archive, dependencies) });
		}
		if (!capturedHop) {
			await SubmissionsEntity.update(submissionId, {
				status: "invalid",
				info: `${archive.attributionError} No report was created; resubmit the exact site whose page should be analyzed.`,
			});
			await emitStep(submissionId, "completed", 100);
			return submissionId;
		}
		await SubmissionsEntity.update(submissionId, {
			data: {
				kind: "website",
				website: { url, whois, ...capturedWebsiteData(archive) },
			},
		});

		const visited = await visitWebsite({ submissionId, url, whois, archive, dependencies, capture }).finally(closeSessions);
		archive = visited.archive;
		capturedHop = visited.capturedHop;
		const { classification: capturedClassification, record: visit } = visited;
		if (visited.handedOff) {
			await handOffRedirectedCapture({ submissionId, url, whois, archive, capturedHop, via: "its own flow", reporter: { reporterIp, reporterCountry, reporterHeaders }, dependencies, analyze });
			await emitStep(submissionId, "completed", 100);
			return submissionId;
		}

		// Decided once, before the narrative: it explains this finding and never judges the site again.
		const siteAssessments = visited.assessments;
		const reportableSite = reportableWebsiteHop(archive.navigationHops, siteAssessments, archive);
		const commands = extractPasteCommands(archive.text.toString("utf-8"));
		const findingCapture = { commands, navigationHops: archive.navigationHops, hiddenFrames: archive.hiddenFrames, device: archive.device, providerWarning: archive.providerWarning, offeredDownload: archive.offeredDownload, dataDrops: visited.dataDrops };
		const inconclusive = reportableSite ? undefined : visited.inconclusive
			&& `Inconclusive: the visit could not finish the site's flow: ${visited.inconclusive} The last page it reached, ${archive.url}, shows nothing reportable by itself; no verdict or report was made.`;
		const caseFinding = reportableSite
			? `${buildWebsiteReportEvidence(capturedClassification, findingCapture)}\nThe site is reported to the responsible providers.`
			: visited.cloakedDestination ? cloakedDestinationInfo(visited.cloakedDestination)
			: inconclusive ?? unreportedVerdict(capturedClassification, archive.url);

		await emitStep(submissionId, "analysis_run", 75);
		await runStreamedAnalysisRun({
			submissionId,
			analysisKind: "analysis",
			options: {
				model: defaultResponseModel,
				input: buildWebsiteAnalysisInput(archive, { finding: caseFinding, whois, pages: visited.pages, visit, kitResources: archive.kitResources, capturedAt: archive.archivedAt }),
				reasoning: defaultReasoning,
				tools: [{ type: "web_search" }],
				stream: true,
			},
		}, { client: dependencies.analysisClient });

		await SubmissionsEntity.update(submissionId, {
			data: {
				kind: "website",
				website: { url, whois, ...capturedWebsiteData(archive), siteAssessments, visit, ...(visited.laterPages ? { laterPages: visited.laterPages } : {}), ...(visited.cloakedDestination ? { cloakedDestination: visited.cloakedDestination } : {}) },
			},
		});

		if (reportableSite) {
			const finding = reportableFinding(capturedClassification);
			const label = finding.finding === "malware" ? "Malware distribution" : "Phishing";
			await emitStep(submissionId, "reporting", 90);
			const reportUrls = websiteReportUrls(archive.navigationHops, reportableSite);
			const accessGate = await reportAccessGate(submissionId, reportableSite.url, archive.userAgent, dependencies.bareVisit);
			await reportConfirmedWebsiteAbuse({
				submissionId,
				urls: reportUrls,
				analysisText: buildWebsiteReportEvidence(capturedClassification, { ...findingCapture, ...(visitor ? { reporterUserAgent: visitor.override.userAgent } : {}), accessGate, caseUrl: abuseEmailCaseUrl(submissionId) }),
				...(archive.userAgent ? { userAgent: archive.userAgent } : {}),
				screenshots: await capturedPageScreenshots(submissionId, analyzedCaptureStep(archive.navigationHops)),
				reporter: { reporterIp, reporterCountry, reporterHeaders },
				finding,
				pasteCommands: commands,
				...(finding.finding === "malware" && archive.offeredDownload ? { offeredDownload: archive.offeredDownload } : {}),
				...(capturedClassification.impersonatedBrand ? { legalBrandUrl: capturedClassification.impersonatedBrand.officialUrl } : {}),
				...(capturedClassification.hiddenFrame ? { hiddenFrame: classifiedHiddenFrame(capturedClassification, archive.hiddenFrames)! } : {}),
				...(visited.backends.length ? { visitCapture: { canaries: visited.canaries, requests: visited.requests, backends: visited.backends } } : {}),
			});

			await SubmissionsEntity.update(submissionId, {
				status: "reported",
				info: reportUrls.length === 1
					? `${label} confirmed at ${reportableSite.url}; its evidence is being collected before the report is sent.`
					: `${label} confirmed at ${reportableSite.url}; evidence for it and the ${reportUrls.length - 1} URL${reportUrls.length === 2 ? "" : "s"} on ${websiteSite(reportableSite.url)} that lead${reportUrls.length === 2 ? "s" : ""} to it is being collected before the report is sent.`,
			});
		} else if (visited.inconclusive && inconclusive) {
			// The visit did not finish, so the last page it reached is no verdict on the site.
			await failWebsiteAnalysis(submissionId, {
				info: inconclusive,
				data: { unfinishedFlow: visited.inconclusive },
				retry: { attempts: priorAttempts, reason: visited.inconclusive, exhausted: (visits: number) => `The visit stopped there ${visits} times; retry to visit the site again.` },
			});
			await emitStep(submissionId, "failed", 100);
			return submissionId;
		} else {
			await SubmissionsEntity.update(submissionId, { status: "invalid", info: caseFinding });
		}

		await emitStep(submissionId, "completed", 100);
	} catch (error) {
		console.error("Website analysis failed:", error);
		await recordWebsiteAnalysisFailure(submissionId, error, priorAttempts);
		await emitStep(submissionId, "failed", 100);
	} finally {
		await closeSessions();
		await settleCloakedRedirectsTo(submissionId).catch((error: unknown) => console.error("Settling redirected cases failed:", error));
	}

	return submissionId;
}

/**
 * The gate in front of a page about to be reported, with what a visitor
 * without its session gets now, kept with the case for the report and for
 * answers to providers. A page reached directly is not requested again.
 */
async function reportAccessGate(submissionId: bigint, capturedUrl: string, userAgent: string | undefined, dependencies?: BareVisitDependencies) {
	const gate = accessGateOf(await arrivalChain(submissionId), capturedUrl);
	if (!gate) return undefined;
	const bareVisit = await checkBareVisit(capturedUrl, userAgent, dependencies);
	const accessGate = bareVisit ? { ...gate, bareVisit } : gate;
	await SubmissionsEntity.setWebsiteField(submissionId, "accessGate", accessGate);
	return accessGate;
}

/**
 * A website visit the server's restart cut off: queued for the automatic
 * retry like a browser-service failure. The retry boundary still refuses a
 * case that reached reporting, so nothing is reported twice.
 */
export async function retryInterruptedWebsiteAnalysis(submissionId: bigint): Promise<void> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (submission?.data.kind !== "website") return;
	const reason = "The server restarted during the visit.";
	await failWebsiteAnalysis(submissionId, {
		info: reason,
		retry: { attempts: submission.data.website.autoRetry?.attempts ?? 0, reason, exhausted: (visits) => `It was cut off ${visits} times; retry to visit the site again.` },
	});
}

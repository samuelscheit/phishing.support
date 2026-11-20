import { z } from "zod";

import { createDraft, type RouteDeps } from "../kit/draft";
import { payloadEnvelope, storedReader } from "../kit/stored";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderCorrespondence,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import {
	cloudflareApiConfig,
	cloudflareReceiptSuccess,
	fetchCloudflareSubmittedReport,
	findSubmittedCloudflareReport,
	submitCloudflareAbuseReport,
	type CloudflareApiFetch,
	type CloudflareSessionProvider,
} from "./api";
import { CLOUDFLARE_PROVIDER } from "./definition";
import { buildCloudflareReportPayload } from "./report";
import { getCloudflareSession, type CloudflareSession } from "./session";

const envelope = payloadEnvelope(CLOUDFLARE_PROVIDER, "cloudflare_abuse_api_v1");
const aUrl = z.string().refine((value) => URL.canParse(value));

/** The durable, secret-free draft: the dashboard API's form fields. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.string().min(1),
	report: z.object({
		name: z.string(),
		email: z.string(),
		company: aUrl,
		urls: aUrl,
		justification: z.string(),
		originalWork: z.string().optional(),
		reportedCountry: z.string(),
		reportedUserAgent: z.string().optional(),
	}),
});

type CloudflareSubmissionPayload = z.infer<typeof payloadSchema>;
export const storedCloudflareSubmissionPayload = storedReader(payloadSchema);

export type CloudflareSubmissionDependencies = RouteDeps & {
	fetch?: CloudflareApiFetch;
	getSession?: CloudflareSessionProvider;
	environment?: Readonly<Record<string, string | undefined>>;
};

const draft = createDraft({
	definition: CLOUDFLARE_PROVIDER,
	reasonPrefix: "cloudflare",
	targetTypes: ["domain"],
	targetReason: "cloudflare_phishing_report_requires_domain_target",
	read: storedCloudflareSubmissionPayload,
	input: ({ report, target }, stored: CloudflareSubmissionPayload | undefined, dependencies: CloudflareSubmissionDependencies) => {
		if (report.allegationCategory !== "phishing" && report.allegationCategory !== "malware") {
			throw new ProviderSubmissionRejectedError("Cloudflare's \"Phishing & Malware\" report can only receive phishing or malware allegations.");
		}
		const observedUrl = stored?.report.urls ?? target.observedUrls[0];
		// Credentials are validated here too, so missing login settings are a retryable configuration error rather than an ambiguous post-marker failure.
		if (!stored && observedUrl) cloudflareApiConfig(dependencies.environment);
		return {
			reportedCountry: report.requesterCountry,
			target: target.normalizedTarget,
			observedUrl: observedUrl ?? "",
			description: report.description,
			allegationCategory: report.allegationCategory,
			legalBrandUrl: report.legalBrandUrl ?? undefined,
			reportedUserAgent: report.reportedUserAgent ?? undefined,
		};
	},
	admit: (_data, input) => input.observedUrl ? undefined : "cloudflare_phishing_report_requires_observed_url",
	// The report builder refuses what the form cannot take: no valid URL, brand or description.
	build: (input) => {
		try {
			return { ...envelope.stamp, target: input.target, report: buildCloudflareReportPayload(input) };
		} catch {
			return undefined;
		}
	},
	targetOf: (payload) => payload.target,
});

/** Build Cloudflare's immutable report before the durable provider marker. */
export const prepareCloudflareSubmission = draft.prepare;

/**
 * Login before the durable irreversible-call marker; session secrets stay
 * ephemeral. A failed login sent nothing, so it is an ordinary retryable
 * failure: the error says when the next login may be tried, and the job
 * waits that long. Only a job that runs out of retries ends the route.
 */
export async function prepareCloudflareExternalSubmission(
	context: ProviderSubmissionContext,
	dependencies: CloudflareSubmissionDependencies = {},
): Promise<ProviderSubmissionPreflight> {
	if (!storedCloudflareSubmissionPayload(context.payload)) {
		throw new ProviderSubmissionNeedsHumanError("The persisted Cloudflare provider payload is malformed; review the draft before submitting.");
	}
	await draft.verify(context, dependencies);
	const config = cloudflareApiConfig(dependencies.environment);
	return { state: await (dependencies.getSession ?? getCloudflareSession)(config, { signal: context.signal }) };
}

/** Submit one already-persisted Cloudflare report through the dashboard API. */
export async function submitCloudflareSubmission(
	context: ProviderSubmissionContext,
	dependencies: CloudflareSubmissionDependencies = {},
	preflight?: ProviderSubmissionPreflight,
): Promise<ProviderSubmissionSuccess> {
	const { payload } = await draft.verify(context, dependencies);
	const prepared = preflight ?? await prepareCloudflareExternalSubmission(context, dependencies);
	return submitCloudflareAbuseReport({
		config: cloudflareApiConfig(dependencies.environment),
		session: prepared.state as CloudflareSession,
		...(dependencies.getSession ? { getSession: dependencies.getSession } : {}),
		report: payload.report,
		target: payload.target,
		...(context.signal ? { signal: context.signal } : {}),
		...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
	});
}

/**
 * Find the report an ambiguous submission filed among the account's submitted
 * reports: Cloudflare stored report 58dd5e517c5fc535 (keychainagent.pro)
 * behind an HTTP 504, and the lookup right after the POST did not list it.
 */
export async function findCloudflareSubmission(
	context: ProviderSubmissionContext & { sentAt: Date },
	dependencies: CloudflareSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess | undefined> {
	const payload = storedCloudflareSubmissionPayload(context.payload);
	if (!payload) return undefined;
	const config = cloudflareApiConfig(dependencies.environment);
	const getSession = dependencies.getSession ?? getCloudflareSession;
	const receipt = await findSubmittedCloudflareReport({
		config,
		session: await getSession(config, { signal: context.signal }),
		getSession,
		report: payload.report,
		target: payload.target,
		sentAt: context.sentAt,
		...(context.signal ? { signal: context.signal } : {}),
		...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
	});
	return receipt ? cloudflareReceiptSuccess(config.accountId, payload.target, receipt) : undefined;
}

/** Read a submitted report's status and Cloudflare's emails about it, by its receipt. */
export async function fetchCloudflareCorrespondence(
	context: { confirmationId: string; signal?: AbortSignal },
	dependencies: CloudflareSubmissionDependencies = {},
): Promise<ProviderCorrespondence> {
	const config = cloudflareApiConfig(dependencies.environment);
	const getSession = dependencies.getSession ?? getCloudflareSession;
	return fetchCloudflareSubmittedReport({
		config,
		session: await getSession(config, { signal: context.signal }),
		getSession,
		reportId: context.confirmationId,
		...(context.signal ? { signal: context.signal } : {}),
		...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
	});
}

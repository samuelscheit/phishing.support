import type {
	ProviderSubmissionContext,
	ProviderSubmissionPreparation,
	ProviderSubmissionSuccess,
	ProviderSubmissionPreflight,
} from "../submission_contracts";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { recordValue, routeContext } from "../../worker/shared";

import { cloudflareApiConfig, submitCloudflareAbuseReport, type CloudflareApiFetch, type CloudflareSessionProvider } from "./api";
import { getCloudflareSession, type CloudflareSession } from "./session";
import { cloudflareServiceIdentity } from "./identity";
import { buildCloudflareReportPayload, type CloudflareReportPayload } from "./report";

type CloudflareSubmissionPayload = {
	adapter: "cloudflare_abuse_api_v1";
	providerNarrativeVersion: 1;
	target: string;
	report: CloudflareReportPayload;
};

export type CloudflareSubmissionDependencies = {
	fetch?: CloudflareApiFetch;
	getSession?: CloudflareSessionProvider;
	environment?: Readonly<Record<string, string | undefined>>;
};

function parseStoredPayload(value: Record<string, unknown>): CloudflareSubmissionPayload | undefined {
	if (value.adapter !== "cloudflare_abuse_api_v1" || value.providerNarrativeVersion !== 1 || typeof value.target !== "string" || !value.target) return undefined;
	const report = recordValue(value.report);
	if (!report
		|| typeof report.name !== "string"
		|| typeof report.email !== "string"
		|| typeof report.company !== "string"
		|| typeof report.urls !== "string"
		|| typeof report.justification !== "string"
		|| typeof report.reportedCountry !== "string"
		|| (report.originalWork !== undefined && typeof report.originalWork !== "string")) return undefined;
	try {
		new URL(report.urls);
		new URL(report.company);
	} catch {
		return undefined;
	}
	return { adapter: "cloudflare_abuse_api_v1", providerNarrativeVersion: 1, target: value.target, report: report as unknown as CloudflareReportPayload };
}

/**
 * Build Cloudflare's immutable report before the durable provider marker.
 * Credentials are validated here too, so missing login settings are a retryable
 * configuration error rather than an ambiguous post-marker failure.
 */
export async function prepareCloudflareSubmission(
	context: ProviderSubmissionContext,
	dependencies: CloudflareSubmissionDependencies = {},
): Promise<ProviderSubmissionPreparation> {
	const { report, target } = await routeContext(context.routeId);
	if (report.allegationCategory !== "phishing") {
		throw new ProviderSubmissionRejectedError("Cloudflare's phishing report can only receive phishing allegations.");
	}
	if (target.targetType !== "domain") {
		return { outcome: "insufficient_evidence", reason: "cloudflare_phishing_report_requires_domain_target" };
	}
	const observedUrl = target.observedUrls[0];
	if (!observedUrl) return { outcome: "insufficient_evidence", reason: "cloudflare_phishing_report_requires_observed_url" };
	cloudflareApiConfig(dependencies.environment);

	return {
		outcome: "ready",
		payload: {
			adapter: "cloudflare_abuse_api_v1",
			providerNarrativeVersion: 1,
			target: target.normalizedTarget,
			report: buildCloudflareReportPayload({
				serviceIdentity: cloudflareServiceIdentity(report.requesterCountry),
				target: target.normalizedTarget,
				observedUrl,
				description: report.description,
				legalBrandUrl: report.legalBrandUrl ?? undefined,
			}),
		},
	};
}

/** Login before the durable irreversible-call marker; session secrets stay ephemeral. */
export async function prepareCloudflareExternalSubmission(
	context: ProviderSubmissionContext,
	dependencies: CloudflareSubmissionDependencies = {},
): Promise<ProviderSubmissionPreflight> {
	if (!parseStoredPayload(context.payload)) {
		throw new ProviderSubmissionNeedsHumanError("The persisted Cloudflare provider payload is malformed; review the draft before submitting.");
	}
	const config = cloudflareApiConfig(dependencies.environment);
	try {
		return { state: await (dependencies.getSession ?? getCloudflareSession)(config, { signal: context.signal }) };
	} catch {
		context.signal?.throwIfAborted();
		throw new ProviderSubmissionNeedsHumanError("Cloudflare dashboard login failed; manual login is required before submitting this report.");
	}
}

/** Submit one already-persisted Cloudflare report through the dashboard API. */
export async function submitCloudflareSubmission(
	context: ProviderSubmissionContext,
	dependencies: CloudflareSubmissionDependencies = {},
	preflight?: ProviderSubmissionPreflight,
): Promise<ProviderSubmissionSuccess> {
	const payload = parseStoredPayload(context.payload);
	if (!payload) throw new Error("The persisted Cloudflare provider payload is malformed.");
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

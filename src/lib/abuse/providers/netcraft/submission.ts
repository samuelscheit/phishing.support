import { providerDefinitionMatchesPin } from "../definition";
import type {
	ProviderSubmissionContext,
	ProviderSubmissionPreparation,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { routeContext } from "../../worker/shared";
import {
	NetcraftSubmissionRejectedError,
	netcraftSubmissionUrl,
	type NetcraftFetch,
	parseNetcraftSubmissionResponse as parseNetcraftApiSubmissionResponse,
} from "../../../netcraft/api";
import { netcraftReporterEmail } from "../../../netcraft/identity";
import { NETCRAFT_PROVIDER } from "./definition";
import {
	buildNetcraftReportUrlsBody,
	buildNetcraftSubmissionPayload,
	storedNetcraftSubmissionPayload,
	type NetcraftSubmissionPayload,
} from "./payload";

export type NetcraftSubmissionDependencies = {
	fetch?: NetcraftFetch;
};

export { netcraftSubmissionUrl };

/**
 * Interpret the documented API response. A malformed success response remains
 * ambiguous after the durable marker, while explicit client rejections are
 * safe terminal provider outcomes.
 */
export async function parseNetcraftSubmissionResponse(
	response: Pick<Response, "ok" | "status" | "text">,
	payload: NetcraftSubmissionPayload,
): Promise<ProviderSubmissionSuccess> {
	try {
		const accepted = await parseNetcraftApiSubmissionResponse(response);
		return {
			confirmationId: accepted.uuid,
			confirmationText: accepted.message ?? "Netcraft accepted the URL report.",
			finalUrl: accepted.submissionUrl,
			submittedTargets: [payload.target.normalizedTarget],
		};
	} catch (error) {
		if (error instanceof NetcraftSubmissionRejectedError) {
			throw new ProviderSubmissionRejectedError(error.message);
		}
		throw error;
	}
}

/** Validate target evidence and service identity before the irreversible request. */
export async function prepareNetcraftSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const { route, report, target } = await routeContext(context.routeId);
	if (route.routeType !== "provider_submission" || route.providerRegistryKey !== NETCRAFT_PROVIDER.key
		|| target.targetType !== "domain") {
		return { outcome: "insufficient_evidence", reason: "netcraft_requires_a_domain_target" };
	}
	if (!providerDefinitionMatchesPin(NETCRAFT_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)) {
		return { outcome: "insufficient_evidence", reason: "netcraft_provider_definition_pin_mismatch" };
	}
	const payload = buildNetcraftSubmissionPayload({
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		description: report.description,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
		reporterEmail: netcraftReporterEmail(),
	});
	if (!payload) return { outcome: "insufficient_evidence", reason: "netcraft_requires_valid_observed_urls_and_report_data" };
	return { outcome: "ready", payload };
}

/** Submit one immutable Netcraft payload after generic execution marks its boundary. */
export async function submitNetcraftSubmission(
	context: ProviderSubmissionContext,
	dependencies: NetcraftSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const payload = storedNetcraftSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Netcraft submission payload is malformed.");
	const { route, report, target } = await routeContext(context.routeId);
	const routeStillMatches = route.routeType === "provider_submission"
		&& route.providerRegistryKey === NETCRAFT_PROVIDER.key
		&& providerDefinitionMatchesPin(NETCRAFT_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash)
		&& target.targetType === "domain"
		&& target.normalizedTarget === payload.target.normalizedTarget
		&& target.observedUrls.length === payload.target.observedUrls.length
		&& target.observedUrls.every((url, index) => url === payload.target.observedUrls[index]);
	if (!routeStillMatches) throw new Error("The persisted Netcraft payload no longer matches its route.");

	// The reporter email was validated and pinned before the marker. Do not
	// re-read configuration here: an operator changing it must not turn an
	// already-prepared report into a different external submission.
	const expected = buildNetcraftSubmissionPayload({
		target: target.normalizedTarget,
		observedUrls: payload.target.observedUrls,
		description: report.description,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
		reporterEmail: payload.report.reporterEmail,
	});
	if (!expected
		|| expected.report.reason !== payload.report.reason
		|| expected.report.reporterEmail !== payload.report.reporterEmail
		|| expected.target.normalizedTarget !== payload.target.normalizedTarget
		|| expected.target.observedUrls.length !== payload.target.observedUrls.length
		|| expected.target.observedUrls.some((url, index) => url !== payload.target.observedUrls[index])) {
		throw new Error("The persisted Netcraft payload no longer matches the report evidence.");
	}

	const request: NetcraftFetch = dependencies.fetch ?? globalThis.fetch;
	const response = await request(NETCRAFT_PROVIDER.reportUrlsUrl, {
		method: "POST",
		redirect: "error",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
		},
		body: JSON.stringify(buildNetcraftReportUrlsBody(payload)),
	});
	return parseNetcraftSubmissionResponse(response, payload);
}

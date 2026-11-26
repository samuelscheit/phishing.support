import { createDraft, reportAccessOf } from "../kit/draft";
import { ProviderSubmissionDuplicateError, ProviderSubmissionRejectedError, type ProviderSubmissionContext, type ProviderSubmissionSuccess } from "../submission_contracts";
import { isNetcraftDuplicateAnswer, NetcraftDuplicateSubmissionError, NetcraftSubmissionRejectedError, netcraftSubmissionUrl, parseNetcraftSubmissionResponse as parseNetcraftApiSubmissionResponse } from "./api";
import { serviceIdentity, serviceUserAgent } from "../../../network/service_identity";
import { NETCRAFT_PROVIDER } from "./definition";
import {
	buildNetcraftReportUrlsBody,
	buildNetcraftSubmissionPayload,
	storedNetcraftSubmissionPayload,
	type NetcraftSubmissionPayload,
} from "./payload";
import { fetchAs, type FetchLike } from "../../../http/fetch";

export type NetcraftSubmissionDependencies = {
	fetch?: FetchLike;
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
		if (error instanceof NetcraftDuplicateSubmissionError) throw netcraftDuplicate(payload);
		if (error instanceof NetcraftSubmissionRejectedError) {
			throw new ProviderSubmissionRejectedError(error.message);
		}
		throw error;
	}
}

/** Netcraft refuses a submission of URLs it has a recent submission for: they are reported. */
function netcraftDuplicate(payload: NetcraftSubmissionPayload): ProviderSubmissionDuplicateError {
	const urls = payload.target.observedUrls;
	return new ProviderSubmissionDuplicateError(urls, {
		confirmationText: `Netcraft already had a recent submission for ${urls.join(", ")}.`,
		submittedTargets: [payload.target.normalizedTarget],
	});
}

/**
 * The duplicate a run settled `provider_rejected` with before duplicates were
 * recognised, read from its failure reason.
 */
export function netcraftDuplicateOfRejection(failureReason: string, payload: NetcraftSubmissionPayload): ProviderSubmissionDuplicateError | undefined {
	const match = /^Netcraft report was rejected with HTTP (\d{3}): ([\s\S]*)$/.exec(failureReason);
	return match && isNetcraftDuplicateAnswer(Number(match[1]), match[2]!) ? netcraftDuplicate(payload) : undefined;
}

export const netcraftDraft = createDraft({
	definition: NETCRAFT_PROVIDER,
	reasonPrefix: "netcraft",
	targetTypes: ["domain", "ip", "service_account", "campaign"],
	targetReason: "netcraft_requires_a_web_target",
	read: storedNetcraftSubmissionPayload,
	input: ({ report, target, accessSteps }, stored: NetcraftSubmissionPayload | undefined) => ({
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		description: report.description,
		...reportAccessOf({ report, accessSteps }),
		allegationCategory: report.allegationCategory,
		...(report.legalBrandUrl ? { legalBrandUrl: report.legalBrandUrl } : {}),
		// The reporter was pinned before the marker: a changed configuration must not turn a prepared report into a different submission.
		reporterEmail: stored?.report.reporterEmail ?? serviceIdentity.mailbox,
	}),
	build: buildNetcraftSubmissionPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

/** Submit one immutable Netcraft payload after generic execution marks its boundary. */
export async function submitNetcraftSubmission(
	context: ProviderSubmissionContext,
	dependencies: NetcraftSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const payload = netcraftDraft.stored(context);
	const response = await fetchAs(serviceUserAgent, dependencies.fetch)(NETCRAFT_PROVIDER.reportUrlsUrl, {
		method: "POST",
		redirect: "error",
		...(context.signal ? { signal: context.signal } : {}),
		headers: {
			accept: "application/json",
			"content-type": "application/json",
		},
		body: JSON.stringify(buildNetcraftReportUrlsBody(payload)),
	});
	return parseNetcraftSubmissionResponse(response, payload);
}

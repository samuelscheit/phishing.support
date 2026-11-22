import { emailOriginOf } from "../email_origin";
import { createDraft, reportInputOf, type RouteData } from "../kit/draft";
import { asRecord } from "../../../util/values";
import { failUnlessFiled } from "../kit/http";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { snippet } from "../../../util/text";
import type { ProviderSubmissionContext, ProviderSubmissionSuccess } from "../submission_contracts";
import { providerResponseId } from "../kit/report_reference";
import { AWS_PROVIDER } from "./definition";
import { awsRequestBody, buildAwsSubmissionPayload, storedAwsSubmissionPayload, type AwsReportInput } from "./payload";
import { deadline } from "../../../util/async";
import { browserUserAgent } from "../../../network/service_identity";
import { fetchAs } from "../../../http/fetch";

export type AwsSubmissionDependencies = {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	/** The time of filing, which the form's event timestamp carries. */
	now?: () => Date;
};

/** The report's inputs; an IP target that sent a phishing email also carries that email's origin. */
async function reportInput(data: RouteData): Promise<AwsReportInput & { capturedAt: Date }> {
	const { target, evidenceArtifacts, report } = data;
	const emailOrigin = target.observedUrls.length === 0 ? await emailOriginOf({ target, evidenceArtifacts }) : undefined;
	return { ...reportInputOf(data), capturedAt: report.createdAt, ...(emailOrigin ? { emailOrigin } : {}) };
}

export const awsDraft = createDraft({
	definition: AWS_PROVIDER,
	label: "AWS",
	reasonPrefix: "aws",
	targetTypes: ["domain", "ip"],
	targetReason: "aws_requires_a_web_target",
	read: storedAwsSubmissionPayload,
	input: reportInput,
	// An address no page was observed on, and no email came from, is not a site: nothing to report to AWS.
	admit: (data, input) => data.target.targetType === "ip" && !input.emailOrigin && data.target.observedUrls.length === 0 ? "aws_requires_an_observed_url_or_the_phishing_email" : undefined,
	build: buildAwsSubmissionPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

/** The handler's answer once this address reached its request limit; it files nothing. */
export const AWS_REQUEST_LIMIT_BODY = '{"errorMessage":"You have reached your request limit, please try again later"}';

/** API Gateway's own body for a request its authorizer, resource policy or WAF denied. */
export const API_GATEWAY_FORBIDDEN_BODY = '{"message":"Forbidden"}';

/**
 * Whether API Gateway itself denied the request: a 403 typed
 * `ForbiddenException` (its `x-amzn-errortype`, optionally `:`-suffixed with
 * a URL) or carrying its exact default body. The gateway answers so before
 * any integration runs, so the report never reached AWS's handler. It denies
 * every client whose User-Agent is not a desktop browser's (probed
 * 2026-11-22: none, `Bun/…`, `curl`, `axios`, `node`, bare `Mozilla/5.0` and
 * `HeadlessChrome` get 403; Chrome or Firefox reach the handler), which is
 * why the request carries the service's browser User-Agent. Any other 403
 * (an application error with its own body) stays ambiguous.
 */
export function isApiGatewayDenial(response: Pick<Response, "status" | "headers">, text: string): boolean {
	if (response.status !== 403) return false;
	return response.headers.get("x-amzn-errortype")?.split(":")[0]?.trim() === "ForbiddenException" || text.trim() === API_GATEWAY_FORBIDDEN_BODY;
}

/** The refusal for API Gateway's denial; `detail` is a snippet of its answer. */
export const apiGatewayDenial = (detail: string) => new ProviderSubmissionRejectedError(`AWS's API gateway denied the report before it was filed (HTTP 403): ${detail}`);

/**
 * File the report: the only work after the durable marker. A refusal naming
 * a bad request, API Gateway's denial, or the handler's request limit means
 * nothing was filed; anything else leaves it ambiguous.
 */
export async function submitAwsSubmission(context: ProviderSubmissionContext, dependencies: AwsSubmissionDependencies = {}): Promise<ProviderSubmissionSuccess> {
	const payload = awsDraft.stored(context);
	const send = fetchAs(browserUserAgent, dependencies.fetch);
	const response = await send(AWS_PROVIDER.endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/plain, */*", origin: AWS_PROVIDER.origin, referer: `${AWS_PROVIDER.origin}/` },
		body: JSON.stringify(awsRequestBody(payload, (dependencies.now ?? (() => new Date()))())),
		signal: deadline(AWS_PROVIDER.timeoutMs, context.signal),
	});
	const text = await response.text();
	if (isApiGatewayDenial(response, text)) throw apiGatewayDenial(snippet(text));
	if (response.status === 429 && text.trim() === AWS_REQUEST_LIMIT_BODY) throw new ProviderSubmissionRejectedError(`AWS refused the report at its request limit (HTTP 429): ${snippet(text)}`);
	failUnlessFiled("AWS", response, snippet(text), [400, 413, 422]);
	let answer: unknown;
	try {
		answer = JSON.parse(text);
	} catch {
		throw new Error(`AWS answered the report with a body that is not JSON: ${snippet(text)}`);
	}
	// The form counts any truthy answer body as filed (axios' `response.data`,
	// its `.then(({ data }) => data && redirectSuccess(…))`), an array or a string too, so a JSON-object reader does not fit;
	// null, false, 0 or "" is not.
	if (!answer) throw new Error(`AWS answered the report with an empty body: ${snippet(text)}`);
	const id = providerResponseId(asRecord(answer)?.data ?? answer);
	return {
		confirmationId: payload.report.trackingId,
		confirmationText: `AWS Trust & Safety accepted the report${id ? ` (${id})` : ""}`,
		finalUrl: AWS_PROVIDER.formUrl,
		submittedTargets: [payload.target.normalizedTarget],
	};
}

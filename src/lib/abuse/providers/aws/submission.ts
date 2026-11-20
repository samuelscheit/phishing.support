import { emailOriginOf } from "../email_origin";
import { createDraft, reportInputOf, type RouteData } from "../kit/draft";
import { asRecord } from "../../../util/values";
import { deadline, failUnlessFiled } from "../kit/http";
import { snippet } from "../kit/text";
import type { ProviderSubmissionContext, ProviderSubmissionSuccess } from "../submission_contracts";
import { providerResponseId } from "../report_reference";
import { AWS_PROVIDER } from "./definition";
import { awsRequestBody, buildAwsSubmissionPayload, storedAwsSubmissionPayload, type AwsReportInput } from "./payload";

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

/** Check the route and build the durable draft before any provider call. */
export const prepareAwsSubmission = (context: ProviderSubmissionContext) => awsDraft.prepare(context);

/**
 * File the report: the only work after the durable marker. A refusal naming
 * a bad request means nothing was filed; anything else leaves it ambiguous.
 */
export async function submitAwsSubmission(context: ProviderSubmissionContext, dependencies: AwsSubmissionDependencies = {}): Promise<ProviderSubmissionSuccess> {
	const payload = awsDraft.stored(context);
	const send = dependencies.fetch ?? fetch;
	const response = await send(AWS_PROVIDER.endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/plain, */*", origin: AWS_PROVIDER.origin },
		body: JSON.stringify(awsRequestBody(payload, (dependencies.now ?? (() => new Date()))())),
		signal: deadline(AWS_PROVIDER.timeoutMs, context.signal),
	});
	const text = await response.text();
	failUnlessFiled("AWS", response, snippet(text), [400, 413, 422]);
	let answer: unknown;
	try {
		answer = JSON.parse(text);
	} catch {
		throw new Error(`AWS answered the report with a body that is not JSON: ${snippet(text)}`);
	}
	// The form counts any truthy answer body as filed (axios' `response.data`,
	// its `.then(({ data }) => data && redirectSuccess(…))`), an array or a string too, so jsonRecord does not fit;
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

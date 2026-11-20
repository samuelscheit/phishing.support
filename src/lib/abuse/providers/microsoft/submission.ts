import { asRecord } from "../../../values";
import { emailOriginOf } from "../email_origin";
import { createDraft, reportInputOf, type RouteData } from "../kit/draft";
import { deadline, failUnlessFiled } from "../kit/http";
import { snippet } from "../kit/text";
import type { ProviderSubmissionContext, ProviderSubmissionSuccess } from "../submission_contracts";
import { providerResponseId } from "../report_reference";
import { MICROSOFT_PROVIDER } from "./definition";
import { buildMicrosoftSubmissionPayload, microsoftRequestBody, storedMicrosoftSubmissionPayload, type MicrosoftReportInput } from "./payload";

export type MicrosoftSubmissionDependencies = {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	/** The time of filing, which the report's observation time carries. */
	now?: () => Date;
};

/** The report's inputs; an IP target that sent a phishing email also carries that email's origin. */
async function reportInput(data: RouteData): Promise<MicrosoftReportInput> {
	const { target, evidenceArtifacts, report } = data;
	const emailOrigin = target.observedUrls.length === 0 ? await emailOriginOf({ target, evidenceArtifacts }) : undefined;
	return { ...reportInputOf(data), capturedAt: report.createdAt, ...(emailOrigin ? { emailOrigin } : {}) };
}

const draft = createDraft({
	definition: MICROSOFT_PROVIDER,
	label: "Microsoft",
	reasonPrefix: "microsoft",
	targetTypes: ["domain", "ip"],
	targetReason: "microsoft_requires_a_web_target",
	read: storedMicrosoftSubmissionPayload,
	input: reportInput,
	// An address no page was observed on, and no email came from, is not a site: nothing to report to MSRC.
	admit: (data, input) => data.target.targetType === "ip" && !input.emailOrigin && data.target.observedUrls.length === 0 ? "microsoft_requires_an_observed_url_or_the_phishing_email" : undefined,
	build: buildMicrosoftSubmissionPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

/** Check the route and build the durable draft before any provider call. */
export const prepareMicrosoftSubmission = (context: ProviderSubmissionContext) => draft.prepare(context);
/** The stored draft, checked against its route and rebuilt from the current report. */
export const verifiedMicrosoftDraft = async (context: ProviderSubmissionContext) => (await draft.verify(context)).payload;

/**
 * File the report: the only work after the durable marker. HTTP 400 is the
 * API's refusal of the request, so nothing was filed; the spec declares only
 * `200` without a body, so any other 2xx is read as filed too. Everything
 * else (429 may follow a duplicate that was already filed, 5xx, the network)
 * leaves it ambiguous.
 */
export async function submitMicrosoftSubmission(context: ProviderSubmissionContext, dependencies: MicrosoftSubmissionDependencies = {}): Promise<ProviderSubmissionSuccess> {
	const payload = await verifiedMicrosoftDraft(context);
	const send = dependencies.fetch ?? fetch;
	const response = await send(MICROSOFT_PROVIDER.endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/plain, */*",
			origin: MICROSOFT_PROVIDER.origin,
			referer: `${MICROSOFT_PROVIDER.origin}/`,
			"request-id": crypto.randomUUID(),
		},
		body: JSON.stringify(microsoftRequestBody(payload, (dependencies.now ?? (() => new Date()))())),
		signal: deadline(MICROSOFT_PROVIDER.timeoutMs, context.signal),
	});
	const text = await response.text();
	failUnlessFiled("Microsoft", response, snippet(text), [400]);
	let answer: unknown;
	try {
		answer = text.trim() ? JSON.parse(text) : undefined;
	} catch {
		answer = undefined;
	}
	const id = providerResponseId(asRecord(answer)?.data ?? answer);
	return {
		// Our reference is the receipt, as for every provider: mail that quotes it attaches to this run.
		confirmationId: payload.report.reference,
		confirmationText: `Microsoft MSRC accepted the report (${payload.report.reference}${id ? `, ${id}` : ""})`,
		finalUrl: MICROSOFT_PROVIDER.formUrl,
		submittedTargets: [payload.target.normalizedTarget],
	};
}

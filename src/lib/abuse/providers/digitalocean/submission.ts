import { hostingAddress } from "../../mail/draft";
import { createDraft, reportInputOf, type RouteData } from "../kit/draft";
import { failUnlessFiled } from "../kit/http";
import type { ProviderSubmissionContext, ProviderSubmissionSuccess } from "../submission_contracts";
import { deadline } from "../../../util/async";
import { browserUserAgent } from "../../../network/service_identity";
import { fetchAs } from "../../../http/fetch";
import { snippet } from "../../../util/text";
import { DIGITALOCEAN_PROVIDER as PROVIDER } from "./definition";
import { buildDigitalOceanSubmissionPayload, storedDigitalOceanSubmissionPayload, type DigitalOceanReportInput, type DigitalOceanSubmissionPayload } from "./payload";

export type DigitalOceanSubmissionDependencies = {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
};

function reportInput(data: RouteData): DigitalOceanReportInput {
	const sourceIp = hostingAddress(data.route, data.target);
	return { ...reportInputOf(data), capturedAt: data.report.createdAt, ...(sourceIp ? { sourceIp } : {}) };
}

export const digitalOceanDraft = createDraft({
	definition: PROVIDER,
	label: "DigitalOcean",
	reasonPrefix: "digitalocean",
	targetTypes: ["domain", "ip"],
	targetReason: "digitalocean_requires_a_web_target",
	read: storedDigitalOceanSubmissionPayload,
	input: reportInput,
	build: buildDigitalOceanSubmissionPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

/** The form's request parts, as its own handler names them. */
export function submissionFields(payload: DigitalOceanSubmissionPayload): Array<[string, string]> {
	const { fields } = PROVIDER;
	const { report } = payload;
	const [date, time] = report.observedAt.split("T") as [string, string];
	const phishing = report.abuseType === PROVIDER.abuseTypes.phishing;
	const parts: Array<[string, string | undefined]> = [
		[fields.name, PROVIDER.reporter.name],
		[fields.email, PROVIDER.reporter.email],
		[fields.campaignTarget, phishing ? report.campaignTarget : undefined],
		[fields.evidenceUrl, report.evidenceUrl],
		[fields.sourceIp, report.sourceIp ?? undefined],
		// The malware form requires evidence tying the source IP to the payload; the description carries it.
		[fields.abuseEvidence, phishing ? undefined : report.details],
		[fields.date, date],
		[fields.time, time.slice(0, 5)],
		[fields.timezone, PROVIDER.timezone],
		[fields.details, report.details],
		[fields.abuseType, report.abuseType],
		[fields.affirmation, PROVIDER.affirmationValue],
	];
	return parts.filter((part): part is [string, string] => part[1] !== undefined).map(([name, value]) => [`abuse_report[${name}]`, value]);
}

/**
 * File the report: the form's one multipart POST. 422 is the API refusing the
 * request (nothing filed); any 2xx (201 without a body) keeps it. Everything
 * else, a 5xx or a lost connection, leaves it open.
 */
export async function submitDigitalOceanSubmission(context: ProviderSubmissionContext, dependencies: DigitalOceanSubmissionDependencies = {}): Promise<ProviderSubmissionSuccess> {
	const payload = digitalOceanDraft.stored(context);
	const body = new FormData();
	for (const [name, value] of submissionFields(payload)) body.append(name, value);
	// The contact form's own request, so it goes out as that page's browser.
	const response = await fetchAs(browserUserAgent, dependencies.fetch)(PROVIDER.endpoint, {
		method: "POST",
		headers: { accept: "application/json, text/plain, */*", origin: PROVIDER.origin, referer: `${PROVIDER.origin}/` },
		body,
		signal: deadline(PROVIDER.timeoutMs, context.signal),
	});
	failUnlessFiled("DigitalOcean", response, snippet(await response.text()) || "(empty answer)", [422]);
	return {
		// The form answers without an id: our reference is the receipt, and DigitalOcean's mail may quote it.
		confirmationId: payload.report.trackingId,
		confirmationText: `DigitalOcean accepted the report (reference ${payload.report.trackingId})`,
		finalUrl: PROVIDER.formUrl,
		submittedTargets: [payload.target.normalizedTarget],
	};
}

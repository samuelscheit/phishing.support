import { routeContext } from "../../worker/shared";
import { asRecord } from "../../../values";
import { abuseEmailCaseUrl, hostingAddressLine } from "../../mail/draft";
import { providerDefinitionMatchesPin } from "../definition";
import {
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { providerResponseId, reportReference } from "../report_reference";
import { AWS_PROVIDER } from "./definition";
import { awsRequestBody, buildAwsSubmissionPayload, storedAwsSubmissionPayload, type AwsReportInput, type AwsSubmissionPayload } from "./payload";

export type AwsSubmissionDependencies = {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	/** The time of filing, which the form's event timestamp carries. */
	now?: () => Date;
};

type Context = Awaited<ReturnType<typeof routeContext>>;

function reportInput({ route, report, target }: Context): AwsReportInput {
	const hostingLine = hostingAddressLine(route);
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	return {
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		description: report.description,
		allegationCategory: report.allegationCategory,
		legalBrandUrl: report.legalBrandUrl,
		trackingId: reportReference(report.id, route.id),
		...(caseUrl ? { caseUrl } : {}),
		...(hostingLine ? { hostingLine } : {}),
	};
}

function routeIsOurs(route: Context["route"]): boolean {
	return route.routeType === "provider_submission" && route.providerRegistryKey === AWS_PROVIDER.key
		&& providerDefinitionMatchesPin(AWS_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash);
}

/** Check the route and build the durable draft before any provider call. */
export async function prepareAwsSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const routeData = await routeContext(context.routeId);
	if (!routeIsOurs(routeData.route)) return { outcome: "insufficient_evidence", reason: "aws_provider_definition_pin_mismatch" };
	if (routeData.target.targetType !== "domain" && routeData.target.targetType !== "ip") return { outcome: "insufficient_evidence", reason: "aws_requires_a_web_target" };
	const payload = buildAwsSubmissionPayload(reportInput(routeData));
	if (!payload) return { outcome: "insufficient_evidence", reason: "aws_report_payload_invalid" };
	return { outcome: "ready", payload };
}

/** The stored draft, checked against its route and rebuilt from the current report. */
export async function verifiedAwsDraft(context: ProviderSubmissionContext): Promise<AwsSubmissionPayload> {
	const payload = storedAwsSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted AWS submission payload is malformed.");
	const routeData = await routeContext(context.routeId);
	if (!routeIsOurs(routeData.route) || routeData.target.normalizedTarget !== payload.target.normalizedTarget) {
		throw new Error("The persisted AWS payload no longer matches its route.");
	}
	const expected = buildAwsSubmissionPayload(reportInput(routeData));
	if (!expected || JSON.stringify(expected) !== JSON.stringify(payload)) throw new Error("The persisted AWS payload no longer matches the report evidence.");
	return payload;
}

function snippet(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * File the report: the only work after the durable marker. A refusal naming
 * a bad request means nothing was filed; anything else leaves it ambiguous.
 */
export async function submitAwsSubmission(context: ProviderSubmissionContext, dependencies: AwsSubmissionDependencies = {}): Promise<ProviderSubmissionSuccess> {
	const payload = await verifiedAwsDraft(context);
	const send = dependencies.fetch ?? fetch;
	const signal = AbortSignal.any([AbortSignal.timeout(AWS_PROVIDER.timeoutMs), ...(context.signal ? [context.signal] : [])]);
	const response = await send(AWS_PROVIDER.endpoint, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/plain, */*", origin: AWS_PROVIDER.origin },
		body: JSON.stringify(awsRequestBody(payload, (dependencies.now ?? (() => new Date()))())),
		signal,
	});
	const text = await response.text();
	if ([400, 413, 422].includes(response.status)) throw new ProviderSubmissionRejectedError(`AWS refused the report (HTTP ${response.status}): ${snippet(text)}`);
	if (!response.ok) throw new Error(`AWS answered the report with HTTP ${response.status}: ${snippet(text)}`);
	let answer: unknown;
	try {
		answer = JSON.parse(text);
	} catch {
		throw new Error(`AWS answered the report with a body that is not JSON: ${snippet(text)}`);
	}
	// The form counts any truthy answer body as filed (axios' `response.data`,
	// its `.then(({ data }) => data && redirectSuccess(…))`); null, false, 0 or "" is not.
	if (!answer) throw new Error(`AWS answered the report with an empty body: ${snippet(text)}`);
	const id = providerResponseId(asRecord(answer)?.data ?? answer);
	return {
		confirmationId: payload.report.trackingId,
		confirmationText: `AWS Trust & Safety accepted the report${id ? ` (${id})` : ""}`,
		finalUrl: AWS_PROVIDER.formUrl,
		submittedTargets: [payload.target.normalizedTarget],
	};
}

import { routeContext } from "../../worker/shared";
import { asRecord } from "../../../values";
import { abuseEmailCaseUrl, hostingAddressLine } from "../../mail/draft";
import { providerDefinitionMatchesPin } from "../definition";
import { providerResponseId, reportReference } from "../report_reference";
import {
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { MICROSOFT_PROVIDER } from "./definition";
import { buildMicrosoftSubmissionPayload, microsoftRequestBody, storedMicrosoftSubmissionPayload, type MicrosoftReportInput, type MicrosoftSubmissionPayload } from "./payload";

export type MicrosoftSubmissionDependencies = {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	/** The time of filing, which the report's observation time carries. */
	now?: () => Date;
};

type Context = Awaited<ReturnType<typeof routeContext>>;

function reportInput({ route, report, target }: Context): MicrosoftReportInput {
	const hostingLine = hostingAddressLine(route);
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	return {
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		description: report.description,
		allegationCategory: report.allegationCategory,
		legalBrandUrl: report.legalBrandUrl,
		reference: reportReference(report.id, route.id),
		...(caseUrl ? { caseUrl } : {}),
		...(hostingLine ? { hostingLine } : {}),
	};
}

function routeIsOurs(route: Context["route"]): boolean {
	return route.routeType === "provider_submission" && route.providerRegistryKey === MICROSOFT_PROVIDER.key
		&& providerDefinitionMatchesPin(MICROSOFT_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash);
}

/** Check the route and build the durable draft before any provider call. */
export async function prepareMicrosoftSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const routeData = await routeContext(context.routeId);
	if (!routeIsOurs(routeData.route)) return { outcome: "insufficient_evidence", reason: "microsoft_provider_definition_pin_mismatch" };
	if (routeData.target.targetType !== "domain" && routeData.target.targetType !== "ip") return { outcome: "insufficient_evidence", reason: "microsoft_requires_a_web_target" };
	const payload = buildMicrosoftSubmissionPayload(reportInput(routeData));
	if (!payload) return { outcome: "insufficient_evidence", reason: "microsoft_report_payload_invalid" };
	return { outcome: "ready", payload };
}

/** The stored draft, checked against its route and rebuilt from the current report. */
export async function verifiedMicrosoftDraft(context: ProviderSubmissionContext): Promise<MicrosoftSubmissionPayload> {
	const payload = storedMicrosoftSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Microsoft submission payload is malformed.");
	const routeData = await routeContext(context.routeId);
	if (!routeIsOurs(routeData.route) || routeData.target.normalizedTarget !== payload.target.normalizedTarget) {
		throw new Error("The persisted Microsoft payload no longer matches its route.");
	}
	const expected = buildMicrosoftSubmissionPayload(reportInput(routeData));
	if (!expected || JSON.stringify(expected) !== JSON.stringify(payload)) throw new Error("The persisted Microsoft payload no longer matches the report evidence.");
	return payload;
}

function snippet(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

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
	const signal = AbortSignal.any([AbortSignal.timeout(MICROSOFT_PROVIDER.timeoutMs), ...(context.signal ? [context.signal] : [])]);
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
		signal,
	});
	const text = await response.text();
	if (response.status === 400) throw new ProviderSubmissionRejectedError(`Microsoft refused the report (HTTP 400): ${snippet(text)}`);
	if (!response.ok) throw new Error(`Microsoft answered the report with HTTP ${response.status}: ${snippet(text)}`);
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

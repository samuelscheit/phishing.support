import { asRecord } from "../../../values";
import { abuseEmailCaseUrl, hostingAddressLine } from "../../mail/draft";
import { AbuseRepository } from "../../repository";
import { routeContext } from "../../worker/shared";
import { openBrowserForm, type BrowserFormChoiceSession, type BrowserFormField, type BrowserFormFile, type BrowserFormResponse } from "../browser_form";
import { providerDefinitionMatchesPin } from "../definition";
import { providerEvidenceImageArtifactMatches } from "../evidence_image";
import { providerResponseId, reportReference } from "../report_reference";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { DYNADOT_PROVIDER as PROVIDER } from "./definition";
import {
	buildDynadotSubmissionPayload,
	DYNADOT_EVIDENCE_CONTRACT,
	selectDynadotEvidenceArtifact,
	storedDynadotSubmissionPayload,
	type DynadotReportInput,
	type DynadotSubmissionPayload,
} from "./payload";

export type DynadotDependencies = {
	/** The browser on the form page with the challenge passed; tests inject a fake. */
	openForm?: (signal: AbortSignal | undefined) => Promise<BrowserFormChoiceSession>;
	loadRouteContext?: typeof routeContext;
	getArtifact?: typeof AbuseRepository.getArtifact;
};

type Context = Awaited<ReturnType<typeof routeContext>>;

/** What the preflight leaves for the one request after the marker. */
export type DynadotPreflightState = {
	session: BrowserFormChoiceSession;
	token: string;
	/** The screenshot, sent as the form's first upload. */
	files: BrowserFormFile[];
};

function reportInput({ route, report, target }: Context): DynadotReportInput {
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
	return route.routeType === "provider_submission" && route.providerRegistryKey === PROVIDER.key
		&& providerDefinitionMatchesPin(PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash);
}

/** Check the route and build the durable draft before any provider call. */
export async function prepareDynadotSubmission(context: ProviderSubmissionContext, dependencies: DynadotDependencies = {}): Promise<ProviderSubmissionPreparation> {
	const routeData = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (!routeIsOurs(routeData.route)) return { outcome: "insufficient_evidence", reason: "dynadot_provider_definition_pin_mismatch" };
	if (routeData.target.targetType !== "domain") return { outcome: "insufficient_evidence", reason: "dynadot_requires_a_domain_target" };
	const payload = buildDynadotSubmissionPayload({ ...reportInput(routeData), evidence: selectDynadotEvidenceArtifact(routeData.evidenceArtifacts) ?? null });
	return payload ? { outcome: "ready", payload } : { outcome: "insufficient_evidence", reason: "dynadot_report_payload_invalid" };
}

/** The stored draft, checked against its route and rebuilt from the current report around its stored screenshot. */
export async function verifiedDynadotDraft(context: ProviderSubmissionContext, dependencies: DynadotDependencies = {}): Promise<{ payload: DynadotSubmissionPayload; routeData: Context }> {
	const payload = storedDynadotSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Dynadot submission payload is malformed.");
	const routeData = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (!routeIsOurs(routeData.route) || routeData.target.normalizedTarget !== payload.target.domain) {
		throw new Error("The persisted Dynadot payload no longer matches its route.");
	}
	const expected = buildDynadotSubmissionPayload({ ...reportInput(routeData), evidence: payload.evidence });
	if (!expected || JSON.stringify(expected) !== JSON.stringify(payload)) throw new Error("The persisted Dynadot payload no longer matches the report evidence.");
	return { payload, routeData };
}

function snippet(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The inputs the phishing form must render for this submission to mean what the draft says. */
const REQUIRED_INPUTS = [PROVIDER.fields.name, PROVIDER.fields.email, PROVIDER.fields.emailConfirmation, PROVIDER.fields.phone, PROVIDER.fields.domain, PROVIDER.fields.officialWebsite, PROVIDER.fields.proxyLocations, PROVIDER.fields.domainPath, PROVIDER.fields.comments];

/**
 * Before the marker: open the form past Cloudflare's challenge, choose the
 * phishing type, wait for the Turnstile token and check the rendered inputs.
 * None of it files a report, so every failure is a safe retry (the browser is
 * closed first).
 */
export async function prepareDynadotExternalSubmission(context: ProviderSubmissionContext, dependencies: DynadotDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const { payload, routeData } = await verifiedDynadotDraft(context, dependencies);
	const files: BrowserFormFile[] = [];
	if (payload.evidence) {
		const artifact = await (dependencies.getArtifact ?? AbuseRepository.getArtifact)(routeData.report.id, BigInt(payload.evidence.artifactId));
		if (!artifact || !providerEvidenceImageArtifactMatches(payload.evidence, artifact, DYNADOT_EVIDENCE_CONTRACT)) {
			throw new Error("The persisted Dynadot evidence artifact no longer matches its immutable reference.");
		}
		files.push({ filename: payload.evidence.filename, mimeType: payload.evidence.mimeType, base64: Buffer.from(artifact.blob).toString("base64") });
	}
	const session = await (dependencies.openForm ?? ((signal) => openBrowserForm({
		provider: PROVIDER.displayName,
		operation: "dynadot-report",
		url: PROVIDER.formUrl,
		formSelector: PROVIDER.abuseTypeSelector,
		...(signal ? { signal } : {}),
	})))(context.signal);
	try {
		if (!await session.selectOption(PROVIDER.abuseTypeSelector, PROVIDER.abuseType)) throw new Error(`Dynadot's abuse form no longer offers the phishing type ${PROVIDER.abuseType}.`);
		const token = await session.waitForTurnstileToken({ widgetSelector: PROVIDER.turnstileWidgetSelector });
		const rendered = await session.readFormFields(`^(${REQUIRED_INPUTS.join("|")})$`, PROVIDER.formSelector);
		const missing = REQUIRED_INPUTS.filter((name) => !rendered.some(([field]) => field === name));
		if (missing.length > 0) throw new Error(`Dynadot's phishing form no longer renders ${missing.join(", ")}.`);
		const state: DynadotPreflightState = { session, token, files };
		return { state, dispose: () => session.close() };
	} catch (error) {
		await session.close();
		throw error;
	}
}

/** The request's parts, in the order the page's own form handler builds them. */
export function submissionFields(payload: DynadotSubmissionPayload, state: Pick<DynadotPreflightState, "token" | "files">): BrowserFormField[] {
	const { fields } = PROVIDER;
	return [
		[fields.name, PROVIDER.reporter.name],
		[fields.email, PROVIDER.reporter.email],
		[fields.emailConfirmation, PROVIDER.reporter.email],
		[fields.phone, ""],
		[fields.domain, payload.target.domain],
		[fields.officialWebsite, payload.report.officialWebsite],
		[fields.proxyLocations, PROVIDER.notApplicable],
		[fields.domainPath, payload.report.domainPath],
		[fields.comments, payload.report.comments],
		...state.files.map((file, index): BrowserFormField => [`${fields.uploadPrefix}${index}${fields.uploadSuffix}`, file]),
		[fields.turnstile, state.token],
		[fields.submit, PROVIDER.submitValue],
		[fields.abuseType, PROVIDER.abuseType],
	];
}

function validationErrors(answer: BrowserFormResponse): string[] | undefined {
	const errors = asRecord(asRecord(answer.json)?.data)?.validation_errors;
	if (!Array.isArray(errors)) return undefined;
	return errors.map((error) => snippet(typeof error === "string" ? error : JSON.stringify(error) ?? ""));
}

/**
 * The one irreversible request: the form's own multipart POST with the pinned
 * draft and the preflight's Turnstile token. The page reports a failure as a
 * non-empty `data.validation_errors` (nothing filed); a failed Turnstile check
 * is a bot verdict on our session, which a person decides. Success is HTTP 200
 * with a `data` object and no validation errors (its exact shape was never
 * captured); anything else leaves it open whether Dynadot kept the report.
 */
export async function submitDynadotSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined): Promise<ProviderSubmissionSuccess> {
	const payload = storedDynadotSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Dynadot submission payload is malformed.");
	const state = preflight?.state as DynadotPreflightState | undefined;
	if (!state?.session || typeof state.token !== "string" || !state.token || !Array.isArray(state.files)) {
		throw new Error("Dynadot submission requires its prepared browser session and Turnstile token.");
	}
	const answer = await state.session.postForm(PROVIDER.submitUrl, submissionFields(payload, state), PROVIDER.timeoutMs, PROVIDER.headers);
	const errors = validationErrors(answer);
	if (errors && errors.length > 0) {
		const listed = errors.join("; ");
		if (/captcha|turnstile/i.test(listed)) throw new ProviderSubmissionNeedsHumanError(`Dynadot's Turnstile check failed for the report: ${listed}`);
		throw new ProviderSubmissionRejectedError(`Dynadot refused the report: ${listed}`);
	}
	const data = asRecord(asRecord(answer.json)?.data);
	if (answer.status !== 200 || !data || (data.validation_errors !== undefined && !errors)) {
		throw new Error(`Dynadot answered the report with HTTP ${answer.status} and no recognizable result: ${snippet(answer.text)}`);
	}
	const caseId = providerResponseId(Object.fromEntries(Object.entries(data).filter(([key]) => key !== "validation_errors" && key !== "highlight_fields")));
	return {
		confirmationId: caseId ?? payload.report.trackingId,
		confirmationText: `Dynadot accepted the report (reference ${payload.report.trackingId})`,
		finalUrl: PROVIDER.formUrl,
		submittedTargets: [payload.target.domain],
	};
}

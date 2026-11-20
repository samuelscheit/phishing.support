import { asRecord } from "../../../util/values";
import type { BrowserFormChoiceSession, BrowserFormField, BrowserFormFile, BrowserFormResponse } from "../browser_form";
import { createDraft, reportInputOf, type RouteDeps } from "../kit/draft";
import { evidenceReferenceOf, loadEvidenceFile } from "../kit/evidence";
import { formOpener, preparedState, withPreflight } from "../kit/session";
import { snippet } from "../../../util/text";
import { providerResponseId } from "../report_reference";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { DYNADOT_PROVIDER as PROVIDER } from "./definition";
import {
	buildDynadotSubmissionPayload,
	DYNADOT_EVIDENCE_CONTRACT,
	storedDynadotSubmissionPayload,
	type DynadotSubmissionPayload,
} from "./payload";

export type DynadotDependencies = RouteDeps & {
	/** The browser on the form page with the challenge passed; tests inject a fake. */
	openForm?: (signal: AbortSignal | undefined) => Promise<BrowserFormChoiceSession>;
	getArtifact?: Parameters<typeof loadEvidenceFile>[0]["getArtifact"];
};

/** What the preflight leaves for the one request after the marker. */
export type DynadotPreflightState = {
	session: BrowserFormChoiceSession;
	token: string;
	/** The screenshot, sent as the form's first upload. */
	files: BrowserFormFile[];
};

export const dynadotDraft = createDraft({
	definition: PROVIDER,
	reasonPrefix: "dynadot",
	targetTypes: ["domain"],
	targetReason: "dynadot_requires_a_domain_target",
	read: storedDynadotSubmissionPayload,
	input: (data, stored?: DynadotSubmissionPayload) => ({ ...reportInputOf(data), evidence: evidenceReferenceOf(DYNADOT_EVIDENCE_CONTRACT, data.evidenceArtifacts, stored) }),
	build: buildDynadotSubmissionPayload,
	targetOf: (payload) => payload.target.domain,
});

/** Check the route and build the durable draft before any provider call. */
export const prepareDynadotSubmission = dynadotDraft.prepare;

/** The inputs the phishing form must render for this submission to mean what the draft says. */
const REQUIRED_INPUTS = [PROVIDER.fields.name, PROVIDER.fields.email, PROVIDER.fields.emailConfirmation, PROVIDER.fields.phone, PROVIDER.fields.domain, PROVIDER.fields.officialWebsite, PROVIDER.fields.proxyLocations, PROVIDER.fields.domainPath, PROVIDER.fields.comments];

/**
 * Before the marker: open the form past Cloudflare's challenge, choose the
 * phishing type, wait for the Turnstile token and check the rendered inputs.
 * None of it files a report, so every failure is a safe retry (the browser is
 * closed first).
 */
export async function prepareDynadotExternalSubmission(context: ProviderSubmissionContext, dependencies: DynadotDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const { payload, data } = await dynadotDraft.verify(context, dependencies);
	const files = payload.evidence
		? [(await loadEvidenceFile({ reference: payload.evidence, contract: DYNADOT_EVIDENCE_CONTRACT, reportId: data.report.id, label: "Dynadot", ...(dependencies.getArtifact ? { getArtifact: dependencies.getArtifact } : {}) })).file]
		: [];
	return withPreflight(() => (dependencies.openForm ?? formOpener(PROVIDER, "dynadot-report", { url: PROVIDER.formUrl, formSelector: PROVIDER.abuseTypeSelector }))(context.signal), async (session): Promise<DynadotPreflightState> => {
		if (!await session.selectOption(PROVIDER.abuseTypeSelector, PROVIDER.abuseType)) throw new Error(`Dynadot's abuse form no longer offers the phishing type ${PROVIDER.abuseType}.`);
		const token = await session.waitForTurnstileToken({ widgetSelector: PROVIDER.turnstileWidgetSelector });
		const rendered = await session.readFormFields(`^(${REQUIRED_INPUTS.join("|")})$`, PROVIDER.formSelector);
		const missing = REQUIRED_INPUTS.filter((name) => !rendered.some(([field]) => field === name));
		if (missing.length > 0) throw new Error(`Dynadot's phishing form no longer renders ${missing.join(", ")}.`);
		return { session, token, files };
	});
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
	const state = preparedState<DynadotPreflightState>(
		preflight,
		(prepared) => !!prepared.session && typeof prepared.token === "string" && !!prepared.token && Array.isArray(prepared.files),
		"Dynadot submission requires its prepared browser session and Turnstile token.",
	);
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

import { createHash, randomUUID } from "node:crypto";

import { asRecord } from "../../../values";
import type { BrowserFormField, BrowserFormFile, BrowserFormRequestSession, BrowserFormResponse, BrowserFormSession } from "../browser_form";
import { createDraft, reportInputOf, type RouteData, type RouteDeps } from "../kit/draft";
import { evidenceReferenceOf, loadEvidenceFile } from "../kit/evidence";
import { formOpener, preparedState, withPreflight } from "../kit/session";
import { snippet } from "../kit/text";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { NAME_COM_PROVIDER as PROVIDER } from "./definition";
import {
	buildNameComSubmissionPayload,
	NAME_COM_EVIDENCE_CONTRACT,
	storedNameComSubmissionPayload,
	type NameComSubmissionPayload,
} from "./payload";

export type NameComSession = BrowserFormSession & BrowserFormRequestSession;

export type NameComDependencies = RouteDeps & {
	/** The browser on the form with the challenge passed; tests inject a fake. */
	openForm?: (signal: AbortSignal | undefined) => Promise<NameComSession>;
	getArtifact?: Parameters<typeof loadEvidenceFile>[0]["getArtifact"];
};

/** What the preflight leaves for the one request after the marker. */
export type NameComPreflightState = {
	session: NameComSession;
	/** The CSRF token the page's session was given; the filing request carries it. */
	csrf: string;
	/** The screenshot, read before the marker, as the form's attachment part. */
	file: BrowserFormFile | null;
};

const draft = createDraft({
	definition: PROVIDER,
	reasonPrefix: "name_com",
	targetTypes: ["domain"],
	targetReason: "name_com_requires_a_domain_target",
	read: storedNameComSubmissionPayload,
	input: (data: RouteData, stored?: NameComSubmissionPayload) => ({ ...reportInputOf(data), evidence: evidenceReferenceOf(NAME_COM_EVIDENCE_CONTRACT, data.evidenceArtifacts, stored) }),
	build: buildNameComSubmissionPayload,
	targetOf: (payload) => payload.target.domain,
});

/** Check the route and build the durable draft before any provider call. */
export const prepareNameComSubmission = draft.prepare;
export const verifiedNameComDraft = draft.verify;

/** The headers of Name.com's CSRF handshake: the token is the SHA-256 of `Start + Time + Start`. */
export function csrfHandshakeHeaders(start: string, time: string, referrer: string): Record<string, string> {
	return {
		time,
		start,
		[PROVIDER.csrfHeader]: createHash("sha256").update(`${start}${time}${start}`).digest("hex"),
		"referrer-override": referrer,
	};
}

/** The CSRF token a handshake answer carries in its response header. */
export function csrfToken(answer: { status: number; text: string; headers: Record<string, string> }): string {
	const token = answer.headers[PROVIDER.csrfHeader];
	if (answer.status !== 200 || !token || !/^[\x21-\x7e]{16,512}$/.test(token)) {
		throw new Error(`Name.com's CSRF handshake gave no token (HTTP ${answer.status}): ${snippet(answer.text)}`);
	}
	return token;
}

/** The `verify_recaptcha` answer's session flag, which the filing request relies on. */
export function captchaAccepted(answer: BrowserFormResponse): boolean {
	const account = asRecord(asRecord(asRecord(answer.json)?.data)?.account);
	return answer.status === 200 && account?.supportFormRecaptcha === true;
}

/**
 * Before the marker: open the form past Cloudflare's challenge, tick the three
 * consents (which reveals the Turnstile widget), take the CSRF token, pass the
 * token to `verify_recaptcha` and read the screenshot. None of it files a
 * ticket, so every failure is a safe retry (the browser is closed first).
 */
export async function prepareNameComExternalSubmission(context: ProviderSubmissionContext, dependencies: NameComDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const { payload, data } = await draft.verify(context, dependencies);
	const file = payload.evidence
		? (await loadEvidenceFile({ reference: payload.evidence, contract: NAME_COM_EVIDENCE_CONTRACT, reportId: data.report.id, label: "Name.com", ...(dependencies.getArtifact ? { getArtifact: dependencies.getArtifact } : {}) })).file
		: null;
	return withPreflight(() => (dependencies.openForm ?? formOpener(PROVIDER, "name-com-report", { url: PROVIDER.formUrl, formSelector: PROVIDER.formSelector }))(context.signal), async (session): Promise<NameComPreflightState> => {
		const ticked = await session.clickAll(PROVIDER.checkboxSelector);
		if (ticked !== PROVIDER.checkboxCount) throw new Error(`Name.com's form has ${ticked} consent checkboxes, not ${PROVIDER.checkboxCount}.`);
		const token = await session.waitForTurnstileToken({ widgetSelector: PROVIDER.turnstileWidgetSelector });
		const referrer = await session.readGlobal("document.referrer");
		const handshake = await session.request({
			method: "GET",
			url: PROVIDER.csrfUrl,
			headers: csrfHandshakeHeaders(randomUUID(), String(Date.now()), typeof referrer === "string" ? referrer : ""),
			timeoutMs: PROVIDER.timeoutMs,
		});
		const csrf = csrfToken(handshake);
		const verified = await session.request({
			method: "POST",
			url: PROVIDER.verifyCaptchaUrl,
			headers: { [PROVIDER.csrfHeader]: csrf },
			json: { supportFormRecaptcha: token },
			timeoutMs: PROVIDER.timeoutMs,
		});
		if (!captchaAccepted(verified)) throw new Error(`Name.com did not accept the Turnstile token (HTTP ${verified.status}): ${snippet(verified.text)}`);
		return { session, csrf, file };
	});
}

/** The ticket request's parts, in the order the page's bundle appends them. */
export function ticketFields(payload: NameComSubmissionPayload, file: BrowserFormFile | null): BrowserFormField[] {
	const { fields, reporter } = PROVIDER;
	return [
		[fields.formType, PROVIDER.formType],
		[fields.firstName, reporter.firstName],
		[fields.lastName, reporter.lastName],
		[fields.email, reporter.email],
		...(file ? [[fields.attachment, file] as BrowserFormField] : []),
		[fields.domain, payload.target.domain],
		[fields.infringement, PROVIDER.infringementType],
		[fields.additional, payload.report.additional],
		[fields.agree, "on"],
		[fields.mayNotRespond, "on"],
		[fields.agree, "on"],
	];
}

/** The answer's own body: the endpoint answers `{success, case_id | message}` (some builds wrap it in `data`). */
function answerBody(json: unknown): Record<string, unknown> | undefined {
	const body = asRecord(json);
	return body && "success" in body ? body : asRecord(body?.data) ?? body;
}

/** Name.com's ticket (case) number: a short alphanumeric token. */
function caseId(value: unknown): string | undefined {
	return (typeof value === "string" || typeof value === "number") && /^[A-Za-z0-9_-]{1,64}$/.test(String(value)) ? String(value) : undefined;
}

/** Answers that name the bot check as the reason: nothing was filed, and a person can file by hand. */
const BOT_VERDICT = /captcha|robot|\bbot\b|spam|verif/i;

/**
 * The one irreversible request: the ticket creation with the pinned draft and
 * the preflight's session. Only a plain refusal (HTTP 400/422, `success: false`,
 * a message) proves nothing was filed; anything else may have created a ticket.
 */
export async function submitNameComSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined): Promise<ProviderSubmissionSuccess> {
	const payload = storedNameComSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Name.com submission payload is malformed.");
	const state = preparedState<NameComPreflightState>(
		preflight,
		(prepared) => !!prepared.session && typeof prepared.csrf === "string" && !!prepared.csrf && (prepared.file === null || typeof prepared.file?.base64 === "string"),
		"Name.com submission requires its prepared browser session and CSRF token.",
	);
	const answer = await state.session.postForm(PROVIDER.submitUrl, ticketFields(payload, state.file), PROVIDER.timeoutMs, { [PROVIDER.csrfHeader]: state.csrf });
	const body = answerBody(answer.json);
	const message = typeof body?.message === "string" ? snippet(body.message) : "";
	const id = caseId(body?.case_id);
	if (answer.status === 200 && body?.success === true && id) {
		return {
			confirmationId: id,
			confirmationText: `Name.com accepted the report as case ${id} (our reference ${payload.report.trackingId})${message ? `: ${message}` : ""}`,
			finalUrl: PROVIDER.formUrl,
			submittedTargets: [payload.target.domain],
		};
	}
	if (body?.success === false && message && (answer.status === 400 || answer.status === 422)) {
		if (BOT_VERDICT.test(message)) throw new ProviderSubmissionNeedsHumanError(`Name.com's bot check held the report back: ${message}`);
		throw new ProviderSubmissionRejectedError(`Name.com refused the report (HTTP ${answer.status}): ${message}`);
	}
	throw new Error(`Name.com answered the report with HTTP ${answer.status}${body?.success === true ? " and success without a case id" : ""}: ${snippet(answer.text)}`);
}

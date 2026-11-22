import { imapConfig } from "../../../mail/config";
import { asRecord, parseJsonRecord } from "../../../util/values";
import { captchaTokenFromPage } from "../kit/captcha";
import { createDraft, reportInputOf, type RouteDeps, type VerifiedOf } from "../kit/draft";
import { evidenceReferenceOf, evidenceFileOf, type EvidenceDependencies } from "../kit/evidence";
import { htmlText } from "../kit/text";
import { mailedCodeReader, type MailedCodeReader } from "../kit/mailed_code";
import { reportReferencesIn } from "../kit/report_reference";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { TUCOWS_PROVIDER } from "./definition";
import {
	buildTucowsSubmissionPayload,
	storedTucowsSubmissionPayload,
	TUCOWS_EVIDENCE_CONTRACT,
	type TucowsSubmissionPayload,
} from "./payload";
import { createTucowsSession, hiddenCsrfToken, metaCsrfToken, redirectPath, type TucowsReply, type TucowsSession } from "./session";
import { type FetchLike } from "../../../http/fetch";

export type TucowsDependencies = RouteDeps & {
	fetch?: FetchLike;
	/** The Turnstile token for the first step; defaults to the wizard's own page in a Fabric browser. */
	solveCaptcha?: (signal?: AbortSignal) => Promise<string>;
	readCode?: MailedCodeReader;
	getArtifact?: EvidenceDependencies["getArtifact"];
	now?: () => Date;
};

/** Everything the one filing request needs, kept in memory from before the marker. */
type TucowsPreflightState = { session: TucowsSession; payload: TucowsSubmissionPayload; screenshot: Buffer; csrfToken: string };

/** The Turnstile token of the wizard's first step, passed by the solver of a Fabric browser on that page. */
const solveTucowsCaptcha = (signal?: AbortSignal) => captchaTokenFromPage({
	provider: TUCOWS_PROVIDER.displayName,
	operation: "tucows-report",
	url: TUCOWS_PROVIDER.reportUrl,
	formSelector: TUCOWS_PROVIDER.captcha.formSelector,
	kind: TUCOWS_PROVIDER.captcha.kind,
}, signal);

export const tucowsDraft = createDraft({
	definition: TUCOWS_PROVIDER,
	label: "Tucows",
	reasonPrefix: "tucows",
	targetTypes: ["domain"],
	targetReason: "tucows_requires_a_domain_target",
	read: storedTucowsSubmissionPayload,
	input: (data, stored?: TucowsSubmissionPayload) => ({ ...reportInputOf(data), evidence: evidenceReferenceOf(TUCOWS_EVIDENCE_CONTRACT, data.evidenceArtifacts, stored) }),
	admit: (data, input) => data.report.allegationCategory === "malware" ? "tucows_files_phishing_only"
		: !data.report.legalBrandUrl ? "tucows_requires_a_brand_domain"
		: !input.evidence ? "tucows_requires_a_screenshot"
		: undefined,
	build: buildTucowsSubmissionPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

const snippet = htmlText;

/**
 * One wizard step: post the page's own hidden CSRF token with the fields, expect
 * the 303 to the next step and read that page. Anything else (the same page
 * again with its error text) means the step refused; nothing is filed before
 * the last step, so the caller's failure is a safe retry.
 */
async function advance(session: TucowsSession, step: string, from: string, fields: Record<string, string>, to: string): Promise<TucowsReply> {
	const page = await session.get(from);
	const csrf = hiddenCsrfToken(page.text);
	if (page.status !== 200 || !csrf) throw new Error(`Tucows' ${step} page did not load (HTTP ${page.status}): ${snippet(page.text)}`);
	const posted = await session.postForm(from, { csrf_token: csrf, ...fields });
	const next = redirectPath(posted);
	if (next !== to) throw new Error(`Tucows refused the ${step} step (HTTP ${posted.status}${posted.location ? ` to ${posted.location}` : ""}): ${snippet(posted.text)}`);
	return session.get(to);
}

/**
 * Before the marker: Turnstile (a Fabric browser on the first page, released
 * before anything is posted), the code request and its entry, the category,
 * and the registrar check. None of it files a report, so every failure is a
 * safe retry; a domain Tucows does not register ends the route for a person.
 */
export async function prepareTucowsExternalSubmission(context: ProviderSubmissionContext, { payload, data }: VerifiedOf<typeof tucowsDraft>, dependencies: TucowsDependencies = {}): Promise<ProviderSubmissionPreflight> {
	if (!dependencies.readCode && !imapConfig()) throw new ProviderSubmissionNeedsHumanError("Tucows reporting requires the IMAP mailbox to receive its verification code.");
	const { bytes: screenshot } = await evidenceFileOf(TUCOWS_EVIDENCE_CONTRACT, "Tucows", payload.evidence, data, dependencies);
	const session = createTucowsSession(dependencies.fetch, context.signal);

	const first = await session.get("/report");
	const firstCsrf = hiddenCsrfToken(first.text);
	if (first.status !== 200 || !firstCsrf) throw new Error(`Tucows' report page did not load (HTTP ${first.status}): ${snippet(first.text)}`);
	const token = await (dependencies.solveCaptcha ?? solveTucowsCaptcha)(context.signal);
	const requestedAt = (dependencies.now ?? (() => new Date()))();
	const sent = await session.postForm("/report", {
		csrf_token: firstCsrf,
		name: TUCOWS_PROVIDER.reporter.name,
		email: TUCOWS_PROVIDER.reporter.email,
		organization: TUCOWS_PROVIDER.reporter.organization,
		role: TUCOWS_PROVIDER.reporter.role,
		"cf-turnstile-response": token,
	});
	if (redirectPath(sent) !== "/report/otp") throw new Error(`Tucows did not send its verification code (HTTP ${sent.status}${sent.location ? ` to ${sent.location}` : ""}): ${snippet(sent.text)}`);

	const code = await (dependencies.readCode ?? mailedCodeReader(TUCOWS_PROVIDER.codeMail))(requestedAt, context.signal);
	if (!/^\d{6}$/.test(code)) throw new Error("Tucows' verification code was not six digits.");
	await advance(session, "code", "/report/otp", { code }, "/report/types");
	const form = await advance(session, "category", "/report/types", { category_id: TUCOWS_PROVIDER.phishingCategoryId, ai_suggestion_accepted: "false" }, "/report/form");
	const csrfToken = hiddenCsrfToken(form.text);
	const apiToken = metaCsrfToken(form.text);
	if (form.status !== 200 || !csrfToken || !apiToken) throw new Error(`Tucows' report form did not load (HTTP ${form.status}): ${snippet(form.text)}`);

	await checkRegistrar(session, payload.report.offendingDomain, apiToken);
	return { state: { session, payload, screenshot, csrfToken } satisfies TucowsPreflightState };
}

/**
 * The form refuses a domain another registrar holds and names that registrar
 * and its abuse contact. The server may check again on submit, so the route
 * ends for a person (who reports to the named registrar) instead of filing here.
 */
async function checkRegistrar(session: TucowsSession, domain: string, apiToken: string): Promise<void> {
	const reply = await session.postJson("/api/user/validate-field", { field_name: "offending_domain", value: domain }, apiToken);
	const answer = parseJsonRecord(reply.text);
	if (reply.status !== 200 || typeof answer?.valid !== "boolean") throw new Error(`Tucows' domain check failed (HTTP ${reply.status}): ${snippet(reply.text)}`);
	if (!answer.valid) {
		const error = typeof answer.error === "string" ? answer.error : "no reason given";
		throw new ProviderSubmissionNeedsHumanError(`Tucows' form does not take ${domain}: ${error}`);
	}
}

const ID_KEYS = ["case_number", "caseNumber", "case_id", "caseId", "reference_number", "referenceNumber", "ticket_id", "ticketId", "ticket_number", "reference", "id"];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,39}$/;

function idFrom(value: unknown, ours: ReadonlySet<string>): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const text = String(value);
	return ID_PATTERN.test(text) && /\d/.test(text) && !ours.has(text) ? text : undefined;
}

/**
 * A case or ticket ID in Tucows' answer (Freshdesk numbers its tickets), when
 * it names one: a JSON key, a "case number: …" sentence, or a path like
 * `/report/confirmation/12345`. Never required; our own reference is no id.
 */
export function tucowsCaseId(reply: { text: string; location?: string }, reference: string): string | undefined {
	const ours = new Set([reference, ...reportReferencesIn(reply.text)]);
	const json = parseJsonRecord(reply.text);
	if (json) for (const key of ID_KEYS) {
		const found = idFrom(json[key], ours) ?? idFrom(asRecord(json.data)?.[key], ours);
		if (found) return found;
	}
	const text = htmlText(reply.text, Number.POSITIVE_INFINITY);
	for (const match of text.matchAll(/\b(?:case|ticket|reference|report)\s*(?:number|no\.?|id|#)?\s*(?:is|:|-)?\s*#?\s*([A-Za-z0-9][A-Za-z0-9_-]{3,39})\b/gi)) {
		const found = idFrom(match[1], ours);
		if (found) return found;
	}
	const fromPath = reply.location?.split(/[?#]/, 1)[0]?.split("/").filter(Boolean).at(-1);
	return idFrom(fromPath, ours);
}

/** Pages of the wizard that come back when the filing request is refused. */
const WIZARD_PATHS = new Set(["/report", "/report/otp", "/report/types", "/report/form", "/report/restart"]);

function filingForm(state: TucowsPreflightState): FormData {
	const { report, evidence } = state.payload;
	const form = new FormData();
	form.set("csrf_token", state.csrfToken);
	form.set("is_domain_owner", "No");
	form.set("offending_domain", report.offendingDomain);
	form.set("target_group", report.brandName);
	form.set("target_group_domain", report.brandDomain);
	form.set("url", report.url);
	form.set("description", report.description);
	form.set("file_upload", new Blob([new Uint8Array(state.screenshot)], { type: evidence.mimeType }), evidence.filename);
	form.set("attest_good_faith", "on");
	form.set("attest_data_processing", "on");
	return form;
}

/**
 * The one irreversible request: the multipart POST /report/form. A named bad
 * request means nothing was filed; a redirect out of the wizard or a page
 * without the form means it was; anything else is ambiguous.
 */
export async function submitTucowsSubmission(_context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight): Promise<ProviderSubmissionSuccess> {
	const state = preflight?.state as TucowsPreflightState | undefined;
	if (!state?.session || !state.payload || !state.csrfToken || !Buffer.isBuffer(state.screenshot)) {
		throw new Error("Tucows submission requires its prepared wizard session.");
	}
	const { reference, offendingDomain } = state.payload.report;
	const reply = await state.session.postMultipart("/report/form", filingForm(state));
	if ([400, 413, 415, 422].includes(reply.status)) throw new ProviderSubmissionRejectedError(`Tucows refused the report (HTTP ${reply.status}): ${snippet(reply.text)}`);
	const next = redirectPath(reply);
	const filed = reply.status >= 300 && reply.status < 400
		? next !== undefined && !WIZARD_PATHS.has(next.split(/[?#]/, 1)[0]!)
		: reply.status >= 200 && reply.status < 300 && !/\bname\s*=\s*["']offending_domain["']/i.test(reply.text);
	if (!filed) throw new Error(`Tucows answered the report with HTTP ${reply.status}${reply.location ? ` to ${reply.location}` : ""}: ${snippet(reply.text)}`);
	let id = tucowsCaseId(reply, reference);
	if (!id && next) {
		// A read of the confirmation page: it may name the case, and its failure changes nothing about the filing.
		const page = await state.session.get(next).catch(() => undefined);
		if (page?.status === 200) id = tucowsCaseId(page, reference);
	}
	return {
		confirmationId: id ?? reference,
		confirmationText: `Tucows accepted the report${id ? ` (case ${id})` : ""}`,
		finalUrl: TUCOWS_PROVIDER.reportUrl,
		submittedTargets: [offendingDomain],
	};
}

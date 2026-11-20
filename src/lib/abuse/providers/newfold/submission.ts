import { abuseEmailCaseUrl, hostingAddressLine } from "../../mail/draft";
import { AbuseRepository } from "../../repository";
import { getDeathByCaptchaCredentials, solveDeathByCaptchaToken } from "../../captcha/death_by_captcha";
import { routeContext } from "../../worker/shared";
import { openBrowserForm, setRecaptchaResponse, type BrowserFormField, type BrowserFormFile, type BrowserFormScripting, type BrowserFormSession } from "../browser_form";
import { providerDefinitionMatchesPin } from "../definition";
import { providerEvidenceImageArtifactMatches } from "../evidence_image";
import { reportReference } from "../report_reference";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { NEWFOLD_PROVIDER as PROVIDER } from "./definition";
import {
	buildNewfoldSubmissionPayload,
	newfoldBrandForRoute,
	NEWFOLD_EVIDENCE_CONTRACT,
	selectNewfoldEvidenceArtifact,
	storedNewfoldSubmissionPayload,
	type NewfoldReportInput,
	type NewfoldSubmissionPayload,
} from "./payload";

type FormSession = BrowserFormSession & BrowserFormScripting;

export type NewfoldDependencies = {
	/** The browser on the form with Cloudflare's check passed; tests inject a fake. */
	openForm?: (signal: AbortSignal | undefined) => Promise<FormSession>;
	/** A solved reCAPTCHA v2 token for the form's page; defaults to Death by Captcha. */
	solveCaptcha?: (signal: AbortSignal | undefined) => Promise<string>;
	/** Whether the captcha service can be paid at all; defaults to the DEATHBYCAPTCHA_* credentials being set. */
	hasCaptchaCredentials?: () => boolean;
	loadRouteContext?: typeof routeContext;
	getArtifact?: typeof AbuseRepository.getArtifact;
};

type Context = Awaited<ReturnType<typeof routeContext>>;

/** What the preflight leaves for the one request after the marker. */
export type NewfoldPreflightState = {
	session: FormSession;
	/** The solved reCAPTCHA v2 token, already in the page's `g-recaptcha-response` textarea. */
	token: string;
	file: BrowserFormFile | undefined;
};

function reportInput({ route, report, target }: Context): NewfoldReportInput {
	const hostingLine = hostingAddressLine(route);
	const caseUrl = abuseEmailCaseUrl(report.submissionId);
	return {
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		description: report.description,
		allegationCategory: report.allegationCategory,
		legalBrandUrl: report.legalBrandUrl,
		trackingId: reportReference(report.id, route.id),
		brand: newfoldBrandForRoute(route),
		...(caseUrl ? { caseUrl } : {}),
		...(hostingLine ? { hostingLine } : {}),
	};
}

function routeIsOurs(route: Context["route"]): boolean {
	return route.routeType === "provider_submission" && route.providerRegistryKey === PROVIDER.key
		&& providerDefinitionMatchesPin(PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash);
}

/** Check the route and build the durable draft before any provider call. */
export async function prepareNewfoldSubmission(context: ProviderSubmissionContext, dependencies: NewfoldDependencies = {}): Promise<ProviderSubmissionPreparation> {
	const routeData = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (!routeIsOurs(routeData.route)) return { outcome: "insufficient_evidence", reason: "newfold_provider_definition_pin_mismatch" };
	if (routeData.target.targetType !== "domain") return { outcome: "insufficient_evidence", reason: "newfold_requires_a_domain_target" };
	const payload = buildNewfoldSubmissionPayload({ ...reportInput(routeData), evidence: selectNewfoldEvidenceArtifact(routeData.evidenceArtifacts) ?? null });
	return payload ? { outcome: "ready", payload } : { outcome: "insufficient_evidence", reason: "newfold_report_payload_invalid" };
}

/** The stored draft, checked against its route and rebuilt from the current report around its stored screenshot. */
export async function verifiedNewfoldDraft(context: ProviderSubmissionContext, dependencies: NewfoldDependencies = {}): Promise<{ payload: NewfoldSubmissionPayload; routeData: Context }> {
	const payload = storedNewfoldSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Newfold submission payload is malformed.");
	const routeData = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (!routeIsOurs(routeData.route) || routeData.target.normalizedTarget !== payload.target.domain) {
		throw new Error("The persisted Newfold payload no longer matches its route.");
	}
	const expected = buildNewfoldSubmissionPayload({ ...reportInput(routeData), evidence: payload.evidence });
	if (!expected || JSON.stringify(expected) !== JSON.stringify(payload)) throw new Error("The persisted Newfold payload no longer matches the report evidence.");
	return { payload, routeData };
}

function snippet(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, 300);
}

function captchaCredentialsPresent(): boolean {
	try {
		getDeathByCaptchaCredentials();
		return true;
	} catch {
		return false;
	}
}

/** Solve the form's reCAPTCHA v2 checkbox (datacenter egress gets the image challenge, so no widget click is tried). */
export function solveNewfoldCaptcha(signal: AbortSignal | undefined): Promise<string> {
	return solveDeathByCaptchaToken({
		type: PROVIDER.captcha.type,
		parametersField: "token_params",
		parameters: { googlekey: PROVIDER.captcha.siteKey, pageurl: PROVIDER.captcha.pageUrl },
		...(signal ? { signal } : {}),
	});
}

/**
 * Before the marker: open the form past Cloudflare's check, check the page
 * still renders the pinned hidden fields, solve the captcha and put its token
 * into the page. None of it files a report, so every failure is a safe retry
 * (the browser is closed first). Without captcha credentials nothing is
 * opened and a person is asked.
 */
export async function prepareNewfoldExternalSubmission(context: ProviderSubmissionContext, dependencies: NewfoldDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const { payload, routeData } = await verifiedNewfoldDraft(context, dependencies);
	let file: BrowserFormFile | undefined;
	if (payload.evidence) {
		const artifact = await (dependencies.getArtifact ?? AbuseRepository.getArtifact)(routeData.report.id, BigInt(payload.evidence.artifactId));
		if (!artifact || !providerEvidenceImageArtifactMatches(payload.evidence, artifact, NEWFOLD_EVIDENCE_CONTRACT)) {
			throw new Error("The persisted Newfold evidence artifact no longer matches its immutable reference.");
		}
		file = { filename: payload.evidence.filename, mimeType: payload.evidence.mimeType, base64: Buffer.from(artifact.blob).toString("base64") };
	}
	if (!(dependencies.hasCaptchaCredentials ?? captchaCredentialsPresent)()) {
		throw new ProviderSubmissionNeedsHumanError("Newfold's abuse form needs a solved reCAPTCHA and DEATHBYCAPTCHA_USERNAME/DEATHBYCAPTCHA_PASSWORD are not set; nothing was filed.");
	}
	const session = await (dependencies.openForm ?? ((signal) => openBrowserForm({
		provider: PROVIDER.displayName,
		operation: "newfold-report",
		url: PROVIDER.formUrl,
		formSelector: PROVIDER.formSelector,
		...(signal ? { signal } : {}),
	}) as Promise<FormSession>))(context.signal);
	try {
		const rendered = await session.readFormFields(PROVIDER.hiddenFieldPattern);
		for (const [name, value] of PROVIDER.hiddenFields) {
			if (rendered.find(([field]) => field === name)?.[1] !== value) throw new Error(`Newfold's form no longer renders ${name}=${value}.`);
		}
		// Last, so the token (valid for about two minutes) is fresh when the request goes out.
		const token = await (dependencies.solveCaptcha ?? solveNewfoldCaptcha)(context.signal);
		await setRecaptchaResponse(session, token, PROVIDER.displayName);
		const state: NewfoldPreflightState = { session, token, file };
		return { state, dispose: () => session.close() };
	} catch (error) {
		await session.close();
		throw error;
	}
}

/** The servlet's multipart parts in the order the form's native submit sends them (docs/providers/newfold.md); the attachment is left out when there is none. */
export function leadFields(payload: NewfoldSubmissionPayload, state: Pick<NewfoldPreflightState, "token" | "file">): BrowserFormField[] {
	const { fields } = PROVIDER;
	return [
		[fields.firstName, PROVIDER.reporter.firstName],
		[fields.lastName, PROVIDER.reporter.lastName],
		[fields.email, PROVIDER.reporter.email],
		[fields.url, payload.report.url],
		[fields.inquiryType, PROVIDER.inquiryType],
		[fields.brand, payload.report.brand],
		[fields.comments, payload.report.comments],
		...(state.file ? [[fields.attachment, state.file] as BrowserFormField] : []),
		[fields.agreement, PROVIDER.agreement],
		[fields.recaptcha, state.token],
		...PROVIDER.hiddenFields.map(([name, value]): BrowserFormField => [name, value]),
	];
}

/** Whether the in-page fetch ended on the thank-you page the servlet redirects to after creating the case. */
function endedOnThankYou(finalUrl: string | undefined): boolean {
	if (!finalUrl) return false;
	const thankYou = new URL(PROVIDER.hiddenFields.find(([name]) => name === "thankyou")![1]);
	try {
		const url = new URL(finalUrl);
		return url.origin === thankYou.origin && url.pathname.replace(/\/$/, "") === PROVIDER.thankYouPath;
	} catch {
		return false;
	}
}

/**
 * The one irreversible request: the multipart POST the form's native submit
 * makes, from inside the page. The servlet answers 302 to the form's `thankyou`
 * page, which names no case. fetch follows the redirect, so a success is
 * decided on the final URL: only the redirect to the thank-you page comes
 * after the lead was created; the servlet's own URL, an error status or any
 * other page leaves it open whether the case exists. Cloudflare's block page
 * and a 413 never reach the servlet, so nothing was filed.
 */
export async function submitNewfoldSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined): Promise<ProviderSubmissionSuccess> {
	const payload = storedNewfoldSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Newfold submission payload is malformed.");
	const state = preflight?.state as NewfoldPreflightState | undefined;
	if (!state?.session || typeof state.token !== "string" || !state.token) {
		throw new Error("Newfold submission requires its prepared browser session and reCAPTCHA token.");
	}
	const answer = await state.session.postForm(PROVIDER.leadUrl, leadFields(payload, state), PROVIDER.timeoutMs);
	if (answer.status >= 200 && answer.status < 300 && endedOnThankYou(answer.url)) {
		return {
			confirmationId: payload.report.trackingId,
			confirmationText: `Newfold accepted the report (redirected to ${answer.url}); it names no case ID, our reference is ${payload.report.trackingId}.`,
			finalUrl: answer.url!,
			submittedTargets: [payload.target.domain],
		};
	}
	if (answer.status === 403 && /just a moment|attention required|cloudflare/i.test(answer.text)) {
		throw new ProviderSubmissionNeedsHumanError(`Newfold's Cloudflare protection blocked the report before it reached the form: ${snippet(answer.text)}`);
	}
	if (answer.status === 413) throw new ProviderSubmissionRejectedError("Newfold refused the report as too large (HTTP 413).");
	throw new Error(`Newfold answered the report with HTTP ${answer.status} at ${answer.url ?? "an unknown URL"}: ${snippet(answer.text)}`);
}

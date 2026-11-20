import type { BrowserFormField, BrowserFormFile, BrowserFormScripting, BrowserFormSession } from "../kit/browser_form";
import { createDraft, type VerifiedOf, reportInputOf, type RouteDeps } from "../kit/draft";
import { evidenceReferenceOf, evidenceFileOf, type EvidenceDependencies } from "../kit/evidence";
import { formOpener, preparedState, withPreflight } from "../kit/session";
import { snippet } from "../../../util/text";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { NEWFOLD_PROVIDER as PROVIDER } from "./definition";
import {
	buildNewfoldSubmissionPayload,
	newfoldBrandForRoute,
	NEWFOLD_EVIDENCE_CONTRACT,
	storedNewfoldSubmissionPayload,
	type NewfoldSubmissionPayload,
} from "./payload";

type FormSession = BrowserFormSession & BrowserFormScripting;

export type NewfoldDependencies = RouteDeps & {
	/** The browser on the form with Cloudflare's check passed; tests inject a fake. */
	openForm?: (signal: AbortSignal | undefined) => Promise<FormSession>;
	getArtifact?: EvidenceDependencies["getArtifact"];
};

/** What the preflight leaves for the one request after the marker. */
export type NewfoldPreflightState = {
	session: FormSession;
	/** The reCAPTCHA v2 token the browser's solver passed, read from the page's `g-recaptcha-response` field. */
	token: string;
	file: BrowserFormFile | undefined;
};

export const newfoldDraft = createDraft({
	definition: PROVIDER,
	reasonPrefix: "newfold",
	targetTypes: ["domain"],
	targetReason: "newfold_requires_a_domain_target",
	read: storedNewfoldSubmissionPayload,
	input: (data, stored?: NewfoldSubmissionPayload) => ({ ...reportInputOf(data), brand: newfoldBrandForRoute(data.route), evidence: evidenceReferenceOf(NEWFOLD_EVIDENCE_CONTRACT, data.evidenceArtifacts, stored) }),
	build: buildNewfoldSubmissionPayload,
	targetOf: (payload) => payload.target.domain,
});

/**
 * Runs in the page: accept OneTrust's cookie banner and hide its container
 * for good (it can come back late), so it never covers the reCAPTCHA widget
 * the solver clicks. Whether there was a banner to accept.
 */
function dismissCookieBanner(banner: { accept: string; container: string }): boolean {
	const accept = document.querySelector(banner.accept) as HTMLElement | null;
	accept?.click();
	const style = document.createElement("style");
	style.textContent = `${banner.container} { display: none !important; }`;
	document.head.append(style);
	return accept !== null;
}

/**
 * Before the marker: open the form past Cloudflare's check, check the page
 * still renders the pinned hidden fields, and wait for the browser's solver
 * to pass the reCAPTCHA (datacenter egress gets the image grid) and read its
 * token. None of it files a report, so every failure is a safe retry (the
 * browser is closed first).
 */
export async function prepareNewfoldExternalSubmission(context: ProviderSubmissionContext, { payload, data }: VerifiedOf<typeof newfoldDraft>, dependencies: NewfoldDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const file = payload.evidence
		? (await evidenceFileOf(NEWFOLD_EVIDENCE_CONTRACT, "Newfold", payload.evidence, data, dependencies)).file
		: undefined;
	return withPreflight(() => (dependencies.openForm ?? formOpener(PROVIDER, "newfold-report", { url: PROVIDER.formUrl, formSelector: PROVIDER.formSelector }))(context.signal), async (session): Promise<NewfoldPreflightState> => {
		const rendered = await session.readFormFields(PROVIDER.hiddenFieldPattern);
		for (const [name, value] of PROVIDER.hiddenFields) {
			if (rendered.find(([field]) => field === name)?.[1] !== value) throw new Error(`Newfold's form no longer renders ${name}=${value}.`);
		}
		await session.evaluate(dismissCookieBanner, PROVIDER.cookieBanner);
		// Last, and read the moment the solver says solved: the token lives about two minutes, and the request follows the marker at once.
		const token = await session.waitForCaptchaToken(PROVIDER.captcha.kind);
		return { session, token, file };
	});
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
export async function submitNewfoldSubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight): Promise<ProviderSubmissionSuccess> {
	const payload = storedNewfoldSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Newfold submission payload is malformed.");
	const state = preparedState<NewfoldPreflightState>(
		preflight,
		(prepared) => !!prepared.session && typeof prepared.token === "string" && !!prepared.token,
		"Newfold submission requires its prepared browser session and reCAPTCHA token.",
	);
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

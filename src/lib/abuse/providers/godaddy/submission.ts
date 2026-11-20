import type { BrowserFormRequestSession, BrowserFormScripting, BrowserFormSession } from "../browser_form";
import { createDraft, reportInputOf, type RouteDeps } from "../kit/draft";
import { formOpener, withPreflight } from "../kit/session";
import {
	ProviderSubmissionNeedsHumanError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { fileGoDaddyTickets, goDaddyApiCredentials, goDaddyApiEnabled, type GoDaddyApiCredentials } from "./api";
import { GODADDY_PROVIDER as PROVIDER } from "./definition";
import { buildGoDaddySubmissionPayload, storedGoDaddySubmissionPayload } from "./payload";
import { interpretPortalAnswer, portalFields, portalRenderedType, recaptchaTokenProbe } from "./portal";
import { type AnswerFetch } from "../../../http/fetch";

export type GoDaddyFormSession = BrowserFormSession & BrowserFormRequestSession & BrowserFormScripting;

export type GoDaddyDependencies = RouteDeps & {
	/** The browser on the Legal Portal form; tests inject a fake. */
	openForm?: (signal: AbortSignal | undefined) => Promise<GoDaddyFormSession>;
	environment?: Readonly<Record<string, string | undefined>>;
	fetch?: AnswerFetch;
};

/** The channel the preflight chose, with what its one filing request needs. Never persisted. */
export type GoDaddyPreflightState =
	| { channel: "api"; credentials: GoDaddyApiCredentials; fetch?: AnswerFetch }
	| { channel: "portal"; session: GoDaddyFormSession; token: string; rendered: Awaited<ReturnType<BrowserFormSession["readFormFields"]>> };

export const goDaddyDraft = createDraft({
	definition: PROVIDER,
	reasonPrefix: "godaddy",
	targetTypes: ["domain"],
	targetReason: "godaddy_requires_a_domain_target",
	read: storedGoDaddySubmissionPayload,
	input: reportInputOf,
	build: buildGoDaddySubmissionPayload,
	targetOf: (payload) => payload.target.domain,
});

/** Check the route and build the durable draft before any provider call. */
export const prepareGoDaddySubmission = goDaddyDraft.prepare;

/**
 * Before the marker, none of which files anything: decide the channel. With an
 * Abuse API key, a read probes whether GoDaddy enabled the reporter (401/403
 * mean not yet: the portal is used). The portal channel opens the form,
 * accepts the cookie banner and takes the invisible reCAPTCHA v3 token from
 * the page's own script. Every failure is a safe retry (the browser is closed).
 */
export async function prepareGoDaddyExternalSubmission(context: ProviderSubmissionContext, dependencies: GoDaddyDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const { payload } = await goDaddyDraft.verify(context, dependencies);
	const credentials = goDaddyApiCredentials(dependencies.environment);
	const fetchDependency = dependencies.fetch ? { fetch: dependencies.fetch } : {};
	if (credentials && await goDaddyApiEnabled(credentials, { ...fetchDependency, ...(context.signal ? { signal: context.signal } : {}) })) {
		return { state: { channel: "api", credentials, ...fetchDependency } satisfies GoDaddyPreflightState };
	}
	// The form's phishing category is the only one the portal route knows.
	if (payload.report.type !== "PHISHING") {
		throw new ProviderSubmissionNeedsHumanError(`GoDaddy's Abuse API is not enabled for this reporter and its Legal Portal route files phishing only, not ${payload.report.type}.`);
	}
	return withPreflight(() => (dependencies.openForm ?? formOpener(PROVIDER, "godaddy-report", { url: PROVIDER.portal.formUrl, formSelector: PROVIDER.portal.formSelector }))(context.signal), async (session): Promise<GoDaddyPreflightState> => {
		await session.clickAll(PROVIDER.portal.cookieBannerAccept);
		const rendered = await session.readFormFields(PROVIDER.portal.renderedFieldPattern);
		const renderedType = portalRenderedType(rendered);
		if (renderedType !== undefined && renderedType !== payload.report.type) throw new Error(`GoDaddy's portal form is no longer the ${payload.report.type} form (it renders type ${renderedType}).`);
		// Last: a v3 token is valid for two minutes only.
		const token = await session.evaluate(recaptchaTokenProbe, { siteKey: PROVIDER.portal.recaptcha.siteKey, action: PROVIDER.portal.recaptcha.action, timeoutMs: PROVIDER.portal.recaptcha.scriptTimeoutMs });
		if (typeof token !== "string" || token.length < 20) throw new Error("GoDaddy's page returned no usable reCAPTCHA token.");
		return { channel: "portal", session, token, rendered };
	});
}

/** The one irreversible request (the portal), or the API's tickets, one per URL, of the channel the preflight chose. */
export async function submitGoDaddySubmission(context: ProviderSubmissionContext, preflight: ProviderSubmissionPreflight | undefined, dependencies: Pick<GoDaddyDependencies, "fetch"> = {}): Promise<ProviderSubmissionSuccess> {
	const payload = storedGoDaddySubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted GoDaddy submission payload is malformed.");
	const state = preflight?.state as GoDaddyPreflightState | undefined;
	const reference = payload.report.trackingId;
	if (state?.channel === "api") {
		const filed = await fileGoDaddyTickets(state.credentials, payload.report.urls, {
			type: payload.report.type,
			target: payload.report.brand,
			info: payload.report.info,
			...(payload.report.caseUrl ? { infoUrl: payload.report.caseUrl } : {}),
		}, { ...(state.fetch ?? dependencies.fetch ? { fetch: (state.fetch ?? dependencies.fetch)! } : {}), ...(context.signal ? { signal: context.signal } : {}) });
		const notes = [
			filed.skipped.length ? `refused as already reported or invalid: ${filed.skipped.join(", ")}` : undefined,
			filed.unfiled.length ? `not filed: ${filed.unfiled.join(", ")}` : undefined,
		].filter((note): note is string => !!note);
		return {
			confirmationId: filed.ticketIds[0]!,
			confirmationText: `GoDaddy's Abuse API created ${filed.ticketIds.length === 1 ? "ticket" : "tickets"} ${filed.ticketIds.join(", ")} for reference ${reference}${notes.length ? ` (${notes.join("; ")})` : ""}`,
			finalUrl: `${PROVIDER.api.baseUrl}${PROVIDER.api.ticketsPath}/${filed.ticketIds[0]!}`,
			submittedTargets: [payload.target.domain],
		};
	}
	if (state?.channel !== "portal" || !state.session || typeof state.token !== "string" || !state.token || !Array.isArray(state.rendered)) {
		throw new Error("GoDaddy submission requires its prepared channel (API credentials or a browser session with a reCAPTCHA token).");
	}
	const answer = await state.session.postForm(
		PROVIDER.portal.submitUrl,
		portalFields(payload, state),
		PROVIDER.portal.timeoutMs,
		{ [PROVIDER.portal.requestHeader.name]: PROVIDER.portal.requestHeader.value },
	);
	const accepted = interpretPortalAnswer(answer);
	return {
		confirmationId: accepted.caseId ?? reference,
		confirmationText: `${accepted.text}; reference ${reference}`,
		finalUrl: PROVIDER.portal.formUrl,
		submittedTargets: [payload.target.domain],
	};
}

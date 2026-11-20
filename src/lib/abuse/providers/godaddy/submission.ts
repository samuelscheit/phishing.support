import { abuseEmailCaseUrl, hostingAddressLine } from "../../mail/draft";
import { routeContext } from "../../worker/shared";
import { openBrowserForm, type BrowserFormRequestSession, type BrowserFormScripting, type BrowserFormSession } from "../browser_form";
import { providerDefinitionMatchesPin } from "../definition";
import { reportReference } from "../report_reference";
import {
	ProviderSubmissionNeedsHumanError,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { fileGoDaddyTickets, goDaddyApiCredentials, goDaddyApiEnabled, type GoDaddyApiCredentials, type GoDaddyFetch } from "./api";
import { GODADDY_PROVIDER as PROVIDER } from "./definition";
import {
	buildGoDaddySubmissionPayload,
	storedGoDaddySubmissionPayload,
	type GoDaddyReportInput,
	type GoDaddySubmissionPayload,
} from "./payload";
import { interpretPortalAnswer, portalFields, portalRenderedType, recaptchaTokenProbe } from "./portal";

export type GoDaddyFormSession = BrowserFormSession & BrowserFormRequestSession & BrowserFormScripting;

export type GoDaddyDependencies = {
	/** The browser on the Legal Portal form; tests inject a fake. */
	openForm?: (signal: AbortSignal | undefined) => Promise<GoDaddyFormSession>;
	loadRouteContext?: typeof routeContext;
	environment?: Readonly<Record<string, string | undefined>>;
	fetch?: GoDaddyFetch;
};

type Context = Awaited<ReturnType<typeof routeContext>>;

/** The channel the preflight chose, with what its one filing request needs. Never persisted. */
export type GoDaddyPreflightState =
	| { channel: "api"; credentials: GoDaddyApiCredentials; fetch?: GoDaddyFetch }
	| { channel: "portal"; session: GoDaddyFormSession; token: string; rendered: Awaited<ReturnType<BrowserFormSession["readFormFields"]>> };

function reportInput({ route, report, target }: Context): GoDaddyReportInput {
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
export async function prepareGoDaddySubmission(context: ProviderSubmissionContext, dependencies: GoDaddyDependencies = {}): Promise<ProviderSubmissionPreparation> {
	const routeData = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (!routeIsOurs(routeData.route)) return { outcome: "insufficient_evidence", reason: "godaddy_provider_definition_pin_mismatch" };
	if (routeData.target.targetType !== "domain") return { outcome: "insufficient_evidence", reason: "godaddy_requires_a_domain_target" };
	const payload = buildGoDaddySubmissionPayload(reportInput(routeData));
	return payload ? { outcome: "ready", payload } : { outcome: "insufficient_evidence", reason: "godaddy_report_payload_invalid" };
}

/** The stored draft, checked against its route and rebuilt from the current report. */
export async function verifiedGoDaddyDraft(context: ProviderSubmissionContext, dependencies: GoDaddyDependencies = {}): Promise<GoDaddySubmissionPayload> {
	const payload = storedGoDaddySubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted GoDaddy submission payload is malformed.");
	const routeData = await (dependencies.loadRouteContext ?? routeContext)(context.routeId);
	if (!routeIsOurs(routeData.route) || routeData.target.normalizedTarget !== payload.target.domain) {
		throw new Error("The persisted GoDaddy payload no longer matches its route.");
	}
	const expected = buildGoDaddySubmissionPayload(reportInput(routeData));
	if (!expected || JSON.stringify(expected) !== JSON.stringify(payload)) throw new Error("The persisted GoDaddy payload no longer matches the report.");
	return payload;
}

/**
 * Before the marker, none of which files anything: decide the channel. With an
 * Abuse API key, a read probes whether GoDaddy enabled the reporter (401/403
 * mean not yet: the portal is used). The portal channel opens the form,
 * accepts the cookie banner and takes the invisible reCAPTCHA v3 token from
 * the page's own script. Every failure is a safe retry (the browser is closed).
 */
export async function prepareGoDaddyExternalSubmission(context: ProviderSubmissionContext, dependencies: GoDaddyDependencies = {}): Promise<ProviderSubmissionPreflight> {
	const payload = await verifiedGoDaddyDraft(context, dependencies);
	const credentials = goDaddyApiCredentials(dependencies.environment);
	const fetchDependency = dependencies.fetch ? { fetch: dependencies.fetch } : {};
	if (credentials && await goDaddyApiEnabled(credentials, { ...fetchDependency, ...(context.signal ? { signal: context.signal } : {}) })) {
		return { state: { channel: "api", credentials, ...fetchDependency } satisfies GoDaddyPreflightState };
	}
	// The form's phishing category is the only one the portal route knows.
	if (payload.report.type !== "PHISHING") {
		throw new ProviderSubmissionNeedsHumanError(`GoDaddy's Abuse API is not enabled for this reporter and its Legal Portal route files phishing only, not ${payload.report.type}.`);
	}
	const session = await (dependencies.openForm ?? ((signal) => openBrowserForm({
		provider: PROVIDER.displayName,
		operation: "godaddy-report",
		url: PROVIDER.portal.formUrl,
		formSelector: PROVIDER.portal.formSelector,
		...(signal ? { signal } : {}),
	})))(context.signal);
	try {
		await session.clickAll(PROVIDER.portal.cookieBannerAccept);
		const rendered = await session.readFormFields(PROVIDER.portal.renderedFieldPattern);
		const renderedType = portalRenderedType(rendered);
		if (renderedType !== undefined && renderedType !== payload.report.type) throw new Error(`GoDaddy's portal form is no longer the ${payload.report.type} form (it renders type ${renderedType}).`);
		// Last: a v3 token is valid for two minutes only.
		const token = await session.evaluate(recaptchaTokenProbe, { siteKey: PROVIDER.portal.recaptcha.siteKey, action: PROVIDER.portal.recaptcha.action, timeoutMs: PROVIDER.portal.recaptcha.scriptTimeoutMs });
		if (typeof token !== "string" || token.length < 20) throw new Error("GoDaddy's page returned no usable reCAPTCHA token.");
		return { state: { channel: "portal", session, token, rendered } satisfies GoDaddyPreflightState, dispose: () => session.close() };
	} catch (error) {
		await session.close();
		throw error;
	}
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

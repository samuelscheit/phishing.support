import { afterEach, describe, expect, test } from "bun:test";

import { contactRoute } from "../../resolver/routes";
import { BrowserFormError, type BrowserFormField, type BrowserFormResponse } from "../browser_form";
import { reportReference } from "../report_reference";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { fetchGoDaddyCorrespondence } from "./correspondence";
import { GODADDY_PROVIDER as PROVIDER } from "./definition";
import { goDaddyConfirmationIds, goDaddyProvider } from "./index";
import { storedGoDaddySubmissionPayload } from "./payload";
import { fetchPortalCaseStatus, interpretPortalAnswer, portalFields, recaptchaTokenProbe } from "./portal";
import {
	prepareGoDaddyExternalSubmission,
	prepareGoDaddySubmission,
	submitGoDaddySubmission,
	type GoDaddyDependencies,
	type GoDaddyFormSession,
	type GoDaddyPreflightState,
} from "./submission";
import { type AnswerFetch } from "../../../http/fetch";
import { formAnswer } from "../kit/testing";

const TARGET = "login-example-phish.com";
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details. Brand: ExampleBank";
const TOKEN = "03AFcWeA".padEnd(1900, "x");
const ENV = { GODADDY_ABUSE_API_KEY: "KEY", GODADDY_ABUSE_API_SECRET: "SECRET" };

function fakeRoute(overrides: Partial<{ category: string; routeId: bigint; targetType: string }> = {}) {
	return async () => ({
		route: { id: overrides.routeId ?? 5n, reportId: 9n, routeType: "provider_submission", providerRegistryKey: "godaddy", providerDefinitionVersion: PROVIDER.version, providerDefinitionHash: PROVIDER.contentHash, routeMetadata: {} },
		report: { id: 9n, submissionId: 377486973465530391n, allegationCategory: overrides.category ?? "phishing", legalBrandUrl: "https://www.examplebank.com/", description },
		target: { normalizedTarget: TARGET, targetType: overrides.targetType ?? "domain", observedUrls: [`https://${TARGET}/signin`, `https://${TARGET}/verify`] },
		evidenceArtifacts: [],
		targets: [],
	}) as never;
}

async function draft(category = "phishing") {
	const loadRouteContext = fakeRoute({ category });
	const prepared = await prepareGoDaddySubmission({ routeId: 5n, payload: {} }, { loadRouteContext });
	if (prepared.outcome !== "ready") throw new Error(`not ready: ${JSON.stringify(prepared)}`);
	return { payload: storedGoDaddySubmissionPayload(prepared.payload)!, loadRouteContext };
}

type Call = { kind: "click"; selector: string } | { kind: "fields"; pattern: string } | { kind: "evaluate"; argument: unknown } | { kind: "post"; url: string; fields: BrowserFormField[]; timeoutMs: number | undefined; headers: unknown };
const RENDERED: BrowserFormField[] = [["type", "PHISHING"], ["form_plid", "1"], ["intentional", "false"]];

function fakeSession(options: { post?: BrowserFormResponse | Error; rendered?: BrowserFormField[]; token?: unknown; evaluateError?: Error } = {}) {
	const calls: Call[] = [];
	let closed = 0;
	const session = {
		clickAll: async (selector: string) => { calls.push({ kind: "click", selector }); return 1; },
		readFormFields: async (pattern: string) => { calls.push({ kind: "fields", pattern }); return options.rendered ?? RENDERED; },
		evaluate: async (_fn: unknown, argument: unknown) => { calls.push({ kind: "evaluate", argument }); if (options.evaluateError) throw options.evaluateError; return "token" in options ? options.token : TOKEN; },
		postForm: async (url: string, fields: readonly BrowserFormField[], timeoutMs?: number, headers?: unknown) => {
			calls.push({ kind: "post", url, fields: [...fields], timeoutMs, headers });
			const answer = options.post ?? formAnswer({ success: ["x"], fail: [] });
			if (answer instanceof Error) throw answer;
			return answer;
		},
		close: async () => { closed++; },
	} as unknown as GoDaddyFormSession;
	return { session, calls, closed: () => closed };
}

type FetchAnswer = { status: number; body?: unknown };
function apiFetch(...answers: Array<FetchAnswer | Error>) {
	const calls: Array<{ url: string; method: string; body: any }> = [];
	const fetch: AnswerFetch = async (url, init = {}) => {
		calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body as string) : undefined });
		const answer = answers.shift() ?? new Error("unexpected call");
		if (answer instanceof Error) throw answer;
		return { status: answer.status, text: async () => answer.body === undefined ? "" : JSON.stringify(answer.body) };
	};
	return { fetch, calls };
}

describe("registry", () => {
	test("abuse@godaddy.com and IANA 146 resolve to the provider and nothing else claims them", async () => {
		const { getProviderSubmissionProviderForMailbox, getProviderSubmissionProviderForRegistrarId, listProviderSubmissionProviders } = await import("../submission_registry_default");
		expect(getProviderSubmissionProviderForMailbox("abuse@godaddy.com")?.definition.key).toBe("godaddy");
		expect(contactRoute({ email: "abuse@godaddy.com", providerName: "GoDaddy", provenance: {}, snapshot: {} })).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "godaddy" });
		expect(getProviderSubmissionProviderForRegistrarId(146)?.definition.key).toBe("godaddy");
		expect(listProviderSubmissionProviders().filter((provider) => provider.definition.exactMailboxes.includes("abuse@godaddy.com")).map((provider) => provider.definition.key)).toEqual(["godaddy"]);
		expect(getProviderSubmissionProviderForMailbox("abuse@sub.godaddy.com")).toBeUndefined();
	});

	test("its mail is read as replies matched by our reference or a DCU case id", () => {
		expect(goDaddyProvider.inboundMail).toMatchObject({ senderDomains: ["godaddy.com"], messageKind: "reply" });
		expect(goDaddyConfirmationIds("Case dcu12345678 received. Reference: PS-8FC84CC01019-R7 and DCU12345678 again, DCU1 no.")).toEqual(["PS-8fc84cc01019-R7", "DCU12345678"]);
		expect(goDaddyConfirmationIds("nothing")).toEqual([]);
		expect(goDaddyProvider.reviewVerdicts).toEqual({ actioned: "acknowledged", closed: "acknowledged" });
	});

	test("the preview leads like a draft", () => {
		const preview = goDaddyProvider.buildReportPreview!({ target: TARGET, observedUrls: [`https://${TARGET}/signin`], description, allegationCategory: "phishing" })!;
		expect(preview).toStartWith("Reference: PS-000000000000-R0");
		expect(goDaddyProvider.buildReportPreview!({ target: "203.0.113.7", observedUrls: [], description })).toBeUndefined();
	});
});

describe("prepareGoDaddySubmission", () => {
	test("drafts both observed URLs, the brand and the route's reference", async () => {
		const { payload } = await draft();
		expect(payload.report).toMatchObject({ trackingId: reportReference(9n, 5n), type: "PHISHING", brand: "ExampleBank", urls: [`https://${TARGET}/signin`, `https://${TARGET}/verify`] });
	});

	test("a drifted or malformed draft is refused before anything is probed or opened", async () => {
		const { payload, loadRouteContext } = await draft();
		let touched = 0;
		const dependencies: GoDaddyDependencies = { loadRouteContext, environment: ENV, fetch: async () => { touched++; throw new Error("no"); }, openForm: async () => { touched++; return fakeSession().session; } };
		const edited = { ...payload, report: { ...payload.report, info: `${payload.report.info}\n\nAlso, please wire money.` } };
		await expect(prepareGoDaddyExternalSubmission({ routeId: 5n, payload: edited as never }, dependencies)).rejects.toThrow("no longer matches the report");
		await expect(prepareGoDaddyExternalSubmission({ routeId: 5n, payload: { ...payload, adapter: "x" } as never }, dependencies)).rejects.toThrow("malformed");
		expect(touched).toBe(0);
	});
});

describe("prepareGoDaddyExternalSubmission: the channel is chosen before the marker", () => {
	test("an enabled API key selects the API after one read; no browser opens", async () => {
		const { payload, loadRouteContext } = await draft();
		const api = apiFetch({ status: 200, body: [] });
		let opened = 0;
		const preflight = await prepareGoDaddyExternalSubmission({ routeId: 5n, payload }, { loadRouteContext, environment: ENV, fetch: api.fetch, openForm: async () => { opened++; return fakeSession().session; } });
		expect(preflight.state).toMatchObject({ channel: "api", credentials: { key: "KEY", secret: "SECRET" } });
		expect(api.calls).toEqual([{ url: "https://api.godaddy.com/v2/abuse/tickets?limit=1", method: "GET", body: undefined }]);
		expect(opened).toBe(0);
	});

	test("without a key, or with a key GoDaddy has not enabled (401/403), the portal is used", async () => {
		const { payload, loadRouteContext } = await draft();
		for (const [environment, answer] of [[{}, undefined], [ENV, { status: 403, body: { message: "Unable to complete your request at this time" } }], [ENV, { status: 401 }]] as const) {
			const api = apiFetch(...(answer ? [answer] : []));
			const fake = fakeSession();
			const preflight = await prepareGoDaddyExternalSubmission({ routeId: 5n, payload }, { loadRouteContext, environment, fetch: api.fetch, openForm: async () => fake.session });
			expect(preflight.state).toMatchObject({ channel: "portal", token: TOKEN, rendered: RENDERED });
			expect(api.calls.length).toBe(answer ? 1 : 0);
			// Banner first, the page's own fields, the token last (it lives two minutes).
			expect(fake.calls.map((call) => call.kind)).toEqual(["click", "fields", "evaluate"]);
			expect(fake.calls[0]).toEqual({ kind: "click", selector: "#pw_accept" });
			expect(fake.calls[2]).toEqual({ kind: "evaluate", argument: { siteKey: "6Lcds5YsAAAAAOxWlnaB1W5e1KIAmk2AhXuUpe97", action: "submit_abuse_report", timeoutMs: 30_000 } });
			await preflight.dispose!();
			expect(fake.closed()).toBe(1);
		}
	});

	test("an API that is down is a retryable error, not a silent fallback to the portal", async () => {
		const { payload, loadRouteContext } = await draft();
		let opened = 0;
		for (const answer of [{ status: 429 }, { status: 503 }, new Error("ECONNRESET")]) {
			await expect(prepareGoDaddyExternalSubmission({ routeId: 5n, payload }, { loadRouteContext, environment: ENV, fetch: apiFetch(answer).fetch, openForm: async () => { opened++; return fakeSession().session; } })).rejects.toThrow();
		}
		expect(opened).toBe(0);
	});

	test("every portal failure happens before the marker and closes the browser", async () => {
		const { payload, loadRouteContext } = await draft();
		const cases: Array<[string, ReturnType<typeof fakeSession>, string]> = [
			["recaptcha script missing", fakeSession({ evaluateError: new BrowserFormError("page", "GoDaddy: the page script failed (grecaptcha did not load)") }), "grecaptcha did not load"],
			["token empty", fakeSession({ token: "" }), "no usable reCAPTCHA token"],
			["token not a string", fakeSession({ token: 5 }), "no usable reCAPTCHA token"],
			["form no longer phishing", fakeSession({ rendered: [["type", "MALWARE"]] }), "no longer the PHISHING form"],
		];
		for (const [name, fake, message] of cases) {
			await expect(prepareGoDaddyExternalSubmission({ routeId: 5n, payload }, { loadRouteContext, environment: {}, openForm: async () => fake.session }), name).rejects.toThrow(message);
			expect(fake.closed(), name).toBe(1);
		}
		await expect(prepareGoDaddyExternalSubmission({ routeId: 5n, payload }, { loadRouteContext, environment: {}, openForm: async () => { throw new BrowserFormError("challenge", "GoDaddy: the Cloudflare challenge was not passed within 60 s"); } })).rejects.toThrow("challenge was not passed");
	});

	test("a malware report cannot use the phishing form: a person, before anything opens", async () => {
		const { payload, loadRouteContext } = await draft("malware");
		let opened = 0;
		const error = await prepareGoDaddyExternalSubmission({ routeId: 5n, payload }, { loadRouteContext, environment: {}, openForm: async () => { opened++; return fakeSession().session; } }).catch((caught) => caught);
		expect(error).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(opened).toBe(0);
		// The enabled API takes MALWARE.
		const preflight = await prepareGoDaddyExternalSubmission({ routeId: 5n, payload }, { loadRouteContext, environment: ENV, fetch: apiFetch({ status: 200, body: [] }).fetch });
		expect(preflight.state).toMatchObject({ channel: "api" });
	});
});

describe("submitGoDaddySubmission: API channel", () => {
	const state = (fetch: AnswerFetch): { state: GoDaddyPreflightState } => ({ state: { channel: "api", credentials: { key: "KEY", secret: "SECRET" }, fetch } });

	test("files one ticket per URL and settles on the first u_number, keeping the reference in the text", async () => {
		const { payload } = await draft();
		const api = apiFetch({ status: 201, body: { u_number: "DCU12345678" } }, { status: 201, body: { u_number: "DCU12345679" } });
		const success = await submitGoDaddySubmission({ routeId: 5n, payload: payload as never }, state(api.fetch));
		expect(success).toEqual({
			confirmationId: "DCU12345678",
			confirmationText: `GoDaddy's Abuse API created tickets DCU12345678, DCU12345679 for reference ${payload.report.trackingId}`,
			finalUrl: "https://api.godaddy.com/v2/abuse/tickets/DCU12345678",
			submittedTargets: [TARGET],
		});
		expect(api.calls.map((call) => call.body)).toEqual(payload.report.urls.map((source) => ({ type: "PHISHING", source, target: "ExampleBank", info: payload.report.info, infoUrl: payload.report.caseUrl })));
	});

	test("a refusal of the first URL is rejected; later trouble is recorded in the text", async () => {
		const { payload } = await draft();
		const context = { routeId: 5n, payload: payload as never };
		await expect(submitGoDaddySubmission(context, state(apiFetch({ status: 422, body: { message: "An open ticket for the same source exists" } }).fetch))).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
		await expect(submitGoDaddySubmission(context, state(apiFetch({ status: 403 }).fetch))).rejects.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		const ambiguous = await submitGoDaddySubmission(context, state(apiFetch({ status: 500 }).fetch)).catch((caught) => caught);
		expect(ambiguous).toBeInstanceOf(Error);
		expect(ambiguous).not.toBeInstanceOf(ProviderSubmissionRejectedError);
		const partial = await submitGoDaddySubmission(context, state(apiFetch({ status: 201, body: { u_number: "DCU12345678" } }, { status: 503 }).fetch));
		expect(partial.confirmationText).toContain(`not filed: ${payload.report.urls[1]}`);
	});
});

describe("submitGoDaddySubmission: portal channel", () => {
	async function prepared(post?: BrowserFormResponse | Error) {
		const { payload } = await draft();
		const fake = fakeSession({ ...(post ? { post } : {}) });
		const state: GoDaddyPreflightState = { channel: "portal", session: fake.session, token: TOKEN, rendered: RENDERED };
		return { context: { routeId: 5n, payload: payload as never }, payload, fake, preflight: { state } };
	}

	test("posts exactly the form's fields with the portal header, once, and settles on the portal's case id", async () => {
		const { context, payload, fake, preflight } = await prepared(formAnswer({ success: [{ caseId: "DCU12345678" }], fail: [] }));
		const success = await submitGoDaddySubmission(context, preflight);
		expect(success).toEqual({
			confirmationId: "DCU12345678",
			confirmationText: `GoDaddy's Legal Portal accepted the report; reference ${payload.report.trackingId}`,
			finalUrl: "https://legalportal.godaddy.com/abuse/phishing",
			submittedTargets: [TARGET],
		});
		expect(fake.calls).toHaveLength(1);
		const post = fake.calls[0] as Extract<Call, { kind: "post" }>;
		expect(post.url).toBe("https://legalportal.godaddy.com/api/v1/submit/abuse");
		expect(post.headers).toEqual({ "X-Portal-Request": "1" });
		expect(post.timeoutMs).toBe(60_000);
		expect(post.fields).toEqual([
			["type", "PHISHING"],
			["contact_email", "support@phishing.support"],
			["source", JSON.stringify(payload.report.urls)],
			["target", "ExampleBank"],
			["useragent", ""],
			["proxy", "N/A"],
			["info", payload.report.info],
			["confirmed", "true"],
			["contact_name", ""], ["url", "[]"], ["email_headers", ""], ["intentional", "false"], ["form_plid", "1"], ["electronic_signature", ""],
			["captcha_code", TOKEN],
		]);
	});

	test("without a case id in the answer the reference is the confirmation (the id arrives by mail)", async () => {
		const { context, payload, preflight } = await prepared(formAnswer({ success: ["Report received"], fail: [] }));
		expect((await submitGoDaddySubmission(context, preflight)).confirmationId).toBe(payload.report.trackingId);
	});

	test("refusals that prove nothing was filed are rejected; a captcha verdict goes to a person", async () => {
		for (const result of [
			formAnswer({ error: "Invalid source URL", success: [], fail: [] }, 400),
			formAnswer({ success: [], fail: ["https://a.com/ is not hosted or registered at GoDaddy"] }),
		]) {
			const { context, preflight } = await prepared(result);
			expect(await submitGoDaddySubmission(context, preflight).catch((caught) => caught)).toBeInstanceOf(ProviderSubmissionRejectedError);
		}
		for (const result of [formAnswer({ error: "Captcha verification is required", success: [], fail: [] }, 400), formAnswer({ error: "reCAPTCHA verification failed", success: [], fail: [] }, 400)]) {
			const { context, preflight } = await prepared(result);
			expect(await submitGoDaddySubmission(context, preflight).catch((caught) => caught)).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		}
	});

	test("everything else is ambiguous, never a rejection", async () => {
		const results: Array<[string, BrowserFormResponse | Error]> = [
			["akamai 403", { status: 403, text: "<html>Access Denied</html>", json: undefined }],
			["429", formAnswer({ error: "Too many requests" }, 429)],
			["500", { status: 500, text: "boom", json: undefined }],
			["200 both empty", formAnswer({ success: [], fail: [] })],
			["200 without lists", formAnswer({ ok: true })],
			["200 non-JSON", { status: 200, text: "<html>", json: undefined }],
			["500 with a refusal-looking body", formAnswer({ error: "Invalid", success: [], fail: [] }, 500)],
			["json null", formAnswer(null)],
			["request failed", new BrowserFormError("request", "GoDaddy: the request to /api/v1/submit/abuse failed (Failed to fetch)")],
		];
		for (const [name, result] of results) {
			const { context, preflight } = await prepared(result);
			const error = await submitGoDaddySubmission(context, preflight).catch((caught) => caught);
			expect(error, name).toBeInstanceOf(Error);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		}
	});

	test("a partial success (some fail) still counts as filed and mentions the refusal", () => {
		const accepted = interpretPortalAnswer(formAnswer({ success: [{ case_id: "DCU12345678" }], fail: ["https://b.com/"] }));
		expect(accepted).toEqual({ caseId: "DCU12345678", text: "GoDaddy's Legal Portal accepted the report (it refused: https://b.com/)" });
		expect(interpretPortalAnswer(formAnswer({ success: ["DCU12345678 created"], fail: [] })).caseId).toBe("DCU12345678");
		expect(interpretPortalAnswer(formAnswer({ success: [12345], fail: [] })).caseId).toBe("12345");
		expect(interpretPortalAnswer(formAnswer({ success: [42], fail: [] })).caseId).toBeUndefined();
	});

	test("never runs without a prepared channel or on a malformed draft, and the entry points need the preflight", async () => {
		const { context, fake, preflight } = await prepared();
		await expect(submitGoDaddySubmission(context, undefined)).rejects.toThrow("requires its prepared channel");
		await expect(submitGoDaddySubmission(context, { state: { ...preflight.state, token: "" } })).rejects.toThrow("requires its prepared channel");
		await expect(submitGoDaddySubmission(context, { state: { channel: "other" } })).rejects.toThrow("requires its prepared channel");
		await expect(submitGoDaddySubmission({ ...context, payload: { ...(context.payload as object), adapter: "x" } as never }, preflight)).rejects.toThrow("malformed");
		expect(fake.calls).toEqual([]);
		await expect(goDaddyProvider.submit(context)).rejects.toThrow("requires its prepared channel");
	});

	test("portalFields prefers the page's rendered hidden values over the defaults, never its type", async () => {
		const { payload } = await draft();
		const fields = portalFields(payload, { rendered: [["form_plid", "7"], ["type", "MALWARE"]], token: "t" });
		expect(fields.find(([name]) => name === "form_plid")).toEqual(["form_plid", "7"]);
		expect(fields.filter(([name]) => name === "type")).toEqual([["type", "PHISHING"]]);
	});
});

describe("recaptchaTokenProbe (runs in the page)", () => {
	const scoped = globalThis as unknown as Record<string, unknown>;
	const saved = scoped.window;
	afterEach(() => { scoped.window = saved; });

	test("waits for the page's script, then executes with the site key and action", async () => {
		const executed: unknown[] = [];
		const page: Record<string, unknown> = {};
		scoped.window = page;
		setTimeout(() => { page.grecaptcha = { ready: (callback: () => void) => callback(), execute: async (...args: unknown[]) => { executed.push(args); return "TOKEN"; } }; }, 300);
		expect(await recaptchaTokenProbe({ siteKey: "K", action: "a", timeoutMs: 5_000 })).toBe("TOKEN");
		expect(executed).toEqual([["K", { action: "a" }]]);
	});

	test("a script that never loads, and an execute that rejects or hangs, fail", async () => {
		scoped.window = {};
		await expect(recaptchaTokenProbe({ siteKey: "K", action: "a", timeoutMs: 400 })).rejects.toThrow("grecaptcha did not load");
		scoped.window = { grecaptcha: { ready: (callback: () => void) => callback(), execute: async () => { throw new Error("invalid site key"); } } };
		await expect(recaptchaTokenProbe({ siteKey: "K", action: "a", timeoutMs: 2_000 })).rejects.toThrow("invalid site key");
		scoped.window = { grecaptcha: { ready: () => undefined, execute: async () => "never" } };
		await expect(recaptchaTokenProbe({ siteKey: "K", action: "a", timeoutMs: 1_000 })).rejects.toThrow("timed out");
	});
});

describe("correspondence", () => {
	const portalAnswer = (status: number, body?: unknown) => async () => ({ status, text: async () => body === undefined ? "" : JSON.stringify(body) });

	test("our reference or an unrecognized id names nothing to look up", async () => {
		for (const confirmationId of ["PS-8fc84cc01019-R7", "something"]) {
			expect(await fetchGoDaddyCorrespondence({ confirmationId }, { environment: ENV, fetch: apiFetch().fetch, portalFetch: portalAnswer(500) })).toEqual({ messages: [] });
		}
	});

	test("an API ticket reports open, then its closeReason as the state", async () => {
		const open = await fetchGoDaddyCorrespondence({ confirmationId: "DCU12345678" }, { environment: ENV, fetch: apiFetch({ status: 200, body: { closed: false } }).fetch });
		expect(open).toEqual({ messages: [], status: { state: "open" }, final: false });
		const closed = await fetchGoDaddyCorrespondence({ confirmationId: "DCU12345678" }, { environment: ENV, fetch: apiFetch({ status: 200, body: { closed: true, closeReason: "Actioned" } }).fetch });
		expect(closed).toEqual({ messages: [], status: { state: "actioned", detail: "GoDaddy closed the ticket: Actioned" }, final: true });
		expect(goDaddyProvider.reviewVerdicts![closed.status!.state]).toBe("acknowledged");
	});

	test("a ticket the API does not know (portal filing, no key) goes through the public case lookup", async () => {
		const bodies: unknown[] = [];
		const portalFetch = async (url: string, init: RequestInit) => {
			bodies.push({ url, headers: init.headers, body: init.body });
			return { status: 200, text: async () => JSON.stringify({ status: "Closed" }) };
		};
		const viaApiMiss = await fetchGoDaddyCorrespondence({ confirmationId: "DCU12345678" }, { environment: ENV, fetch: apiFetch({ status: 404 }).fetch, portalFetch });
		expect(viaApiMiss).toEqual({ messages: [], status: { state: "closed" }, final: true });
		expect(await fetchGoDaddyCorrespondence({ confirmationId: "DCU12345678" }, { environment: {}, portalFetch })).toEqual(viaApiMiss);
		expect(bodies[0]).toMatchObject({ url: "https://legalportal.godaddy.com/api/v1/case-status", headers: { "X-Portal-Request": "1" }, body: JSON.stringify({ caseId: "DCU12345678" }) });
		expect(goDaddyProvider.reviewVerdicts!.closed).toBe("acknowledged");
	});

	test("the case lookup: other states are in review, an unknown claim is no status, a 429 or oddity throws", async () => {
		expect(await fetchPortalCaseStatus("DCU12345678", { fetch: portalAnswer(200, { status: "In Review" }) })).toEqual({ state: "in review", final: false });
		expect(await fetchPortalCaseStatus("DCU12345678", { fetch: portalAnswer(404, { error: "Unable to locate this claim" }) })).toBeUndefined();
		expect(await fetchPortalCaseStatus("DCU12345678", { fetch: portalAnswer(400, { error: "Invalid case ID format" }) })).toBeUndefined();
		await expect(fetchPortalCaseStatus("DCU12345678", { fetch: portalAnswer(429, { error: "Too many requests. Please try again shortly." }) })).rejects.toThrow("HTTP 429");
		await expect(fetchPortalCaseStatus("DCU12345678", { fetch: portalAnswer(200, {}) })).rejects.toThrow("HTTP 200");
		await expect(fetchPortalCaseStatus("DCU12345678", { fetch: portalAnswer(403) })).rejects.toThrow("HTTP 403");
	});
});

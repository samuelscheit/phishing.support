import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { routeFixture, verifiedPrepare } from "../kit/testing";
import { AbuseRepository } from "../../repository";
import { abuseArtifacts, abuseTargets } from "../../schema";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError, type ProviderSubmissionProvider } from "../submission_contracts";
import { executeProviderSubmission } from "../submission_execution";
import { TUCOWS_PROVIDER } from "./definition";
import { tucowsProvider } from "./index";
import { storedTucowsSubmissionPayload } from "./payload";
import { hiddenCsrfToken, metaCsrfToken } from "./session";
import { prepareTucowsExternalSubmission as rawPrepareTucowsExternalSubmission, tucowsDraft, submitTucowsSubmission, tucowsCaseId, type TucowsDependencies } from "./submission";
import { defineProvider } from "../kit/provider";

const prepareTucowsExternalSubmission = verifiedPrepare(tucowsDraft, rawPrepareTucowsExternalSubmission);

useTemporaryDatabase();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("tucows-screenshot")]);
const TARGET = "login-example-phish.com";
const MAILBOXES = ["domainabuse@tucows.com", "abuse@enom.com"];
const description = "Impersonated brand: Example Bank\nThe page asks visitors for a password, sign-in details, a verification code, or identity details.";
const NOW = new Date("2026-11-20T11:02:41.500Z");

const tucowsRoute = (options: { target?: string; allegationCategory?: "phishing" | "malware"; screenshot?: boolean; mailbox?: string; observedUrls?: string[]; legalBrandUrl?: string | null; resolverProvenance?: Record<string, unknown> } = {}) => routeFixture({
	mailbox: options.mailbox ?? MAILBOXES[0]!,
	providerName: "Tucows",
	description,
	target: options.target,
	allegationCategory: options.allegationCategory,
	observedUrls: options.observedUrls,
	legalBrandUrl: options.legalBrandUrl,
	screenshot: options.screenshot === false ? undefined : PNG,
	provenance: options.resolverProvenance,
});

async function readyContext(options: Parameters<typeof tucowsRoute>[0] = {}) {
	const fixture = await tucowsRoute(options);
	const preparation = await tucowsDraft.prepare({ routeId: fixture.route.id, payload: {} });
	if (preparation.outcome !== "ready") throw new Error(`expected ready, got ${JSON.stringify(preparation)}`);
	const payload = storedTucowsSubmissionPayload(preparation.payload);
	if (!payload) throw new Error("expected a stored payload");
	return { ...fixture, payload, context: { routeId: fixture.route.id, payload: payload as unknown as Record<string, unknown> } };
}

type Sent = { method: string; path: string; headers: Record<string, string>; body: unknown };

/**
 * Bullwark's wizard as captured on 2026-11-20: a session cookie `_swb`, a
 * per-page CSRF token that must come back, 303 redirects between steps, and
 * the JSON helper that names the registrar of a domain.
 */
function wizard(options: {
	turnstileToken?: string;
	code?: string;
	registrar?: string | null;
	filing?: (form: FormData) => Response;
	pageCsrf?: boolean;
} = {}) {
	const expected = { token: options.turnstileToken ?? "turnstile-token", code: options.code ?? "364971" };
	const sent: Sent[] = [];
	let step: "report" | "otp" | "types" | "form" | "done" = "report";
	let issued = "";
	let counter = 0;
	let session = "";
	const page = (title: string, extra = "", status = 200) => {
		issued = `csrf-${++counter}+/=`;
		const headers = new Headers({ "content-type": "text/html" });
		if (!session) {
			session = "swb-session";
			headers.append("set-cookie", `_swb=${session}; Path=/; HttpOnly; Secure`);
			headers.append("set-cookie", "csrf_token=cookie-csrf; Path=/; HttpOnly; Secure; SameSite=Strict");
		}
		const hidden = options.pageCsrf === false ? "" : `<input type="hidden" value="${issued.replace(/&/g, "&amp;")}" name="csrf_token">`;
		return new Response(`<html><head><meta name="csrf-token" content="${issued}"></head><body><h1>${title}</h1><form>${hidden}${extra}</form></body></html>`, { status, headers });
	};
	const redirect = (location: string) => new Response(null, { status: 303, headers: { location } });
	const pages = { report: "/report", otp: "/report/otp", types: "/report/types", form: "/report/form" } as const;
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		const target = new URL(url);
		const method = init.method ?? "GET";
		const headers = init.headers as Record<string, string>;
		const body = init.body instanceof FormData ? init.body : init.body ? new URLSearchParams(String(init.body)) : undefined;
		sent.push({ method, path: target.pathname, headers, body });
		expect(init.redirect).toBe("manual");
		expect(target.origin).toBe("https://bullwark.tucows.com");
		if (method === "GET") {
			if (step === "done") return page("Confirmation");
			return target.pathname === pages[step] ? page(step) : redirect(pages[step]);
		}
		// Every POST needs the session cookie and the CSRF of the page last served.
		if (session && !headers.cookie?.includes(`_swb=${session}`)) return new Response("no session", { status: 403 });
		const csrf = body instanceof FormData ? body.get("csrf_token") : body instanceof URLSearchParams ? body.get("csrf_token") ?? headers["x-csrf-token"] : undefined;
		if (csrf !== issued) return new Response("bad csrf", { status: 403 });
		if (target.pathname === "/api/user/validate-field") {
			const value = (body as URLSearchParams).get("value");
			return Response.json(options.registrar ? { valid: false, error: `${value} is not registered through Tucows (registrar: ${options.registrar}) — abuse contact: abuse@registrar.example` } : { valid: true });
		}
		if (step === "done" || target.pathname !== pages[step]) return new Response("wrong step", { status: 409 });
		if (step === "report") {
			const form = body as URLSearchParams;
			if (form.get("cf-turnstile-response") !== expected.token) return page("report", "<p>Captcha failed</p>");
			step = "otp";
			return redirect("/report/otp");
		}
		if (step === "otp") {
			if ((body as URLSearchParams).get("code") !== expected.code) return page("otp", "<p>Invalid code</p>");
			step = "types";
			return redirect("/report/types");
		}
		if (step === "types") {
			step = "form";
			return redirect("/report/form");
		}
		const form = body as FormData;
		const answer = (options.filing ?? (() => redirect("/report/confirmation/FD-48213")))(form);
		if (answer.status >= 300 && answer.status < 400 || answer.status === 200) step = "done";
		return answer;
	};
	return { fetch, sent, posts: () => sent.filter((request) => request.method === "POST"), expected };
}

const deps = (server: ReturnType<typeof wizard>, overrides: Partial<TucowsDependencies> = {}): TucowsDependencies => ({
	fetch: server.fetch,
	solveCaptcha: async () => server.expected.token,
	readCode: async () => server.expected.code,
	now: () => NOW,
	...overrides,
});

const pageHtml = `<form><input type="hidden" name="csrf_token" value="a&amp;b=="><input value='c' name='other'></form><meta content="meta+token" name="csrf-token">`;

describe("page tokens", () => {
	test("reads the hidden and meta tokens in either attribute order", () => {
		expect(hiddenCsrfToken(pageHtml)).toBe("a&b==");
		expect(hiddenCsrfToken('<input name="csrf_token" value="x">')).toBe("x");
		expect(hiddenCsrfToken("<input name='csrf_token' value='y'>")).toBe("y");
		expect(hiddenCsrfToken('<input name="csrf_token" value="">')).toBeUndefined();
		expect(hiddenCsrfToken('<input name="other" value="x">')).toBeUndefined();
		expect(metaCsrfToken(pageHtml)).toBe("meta+token");
		expect(metaCsrfToken('<meta name="viewport" content="x">')).toBeUndefined();
	});
});

describe("tucowsDraft.prepare", () => {
	test("builds the pinned draft with the screenshot, our reference", async () => {
		const { payload, created, route } = await readyContext();
		expect(payload.report).toMatchObject({ offendingDomain: TARGET, brandName: "Example Bank", brandDomain: "examplebank.com", url: `https://${TARGET}/signin` });
		expect(payload.report.reference).toMatch(/^PS-[0-9a-f]{12}-R\d+$/);
		expect(payload.report.reference.endsWith(`-R${route.id}`)).toBeTrue();
		expect(payload.report.description).toStartWith(`Reference: ${payload.report.reference}\n\n`);
		// A public-API report has no case page; the payload tests cover the line.
		expect(payload.report.description).not.toContain("Case details");
		expect(payload.evidence.mimeType).toBe("image/png");
		expect(created.reportId).toBeDefined();
	});

	test("the hosting line is part of the message when the route came from a hosting address", async () => {
		const { payload } = await readyContext({ resolverProvenance: { source: "domain_infrastructure_ip", originatingIp: "203.0.113.9", originatingDomain: TARGET } });
		expect(payload.report.description).toContain("Hosting IP address: 203.0.113.9");
	});

	test("both mailboxes and Tucows' and Enom's registrar IDs select this provider", async () => {
		const { getProviderSubmissionProvider, getProviderSubmissionProviderForMailbox, getProviderSubmissionProviderForRegistrarId } = await import("../submission_registry_default");
		expect(getProviderSubmissionProvider("tucows_bullwark")).toBe(tucowsProvider);
		for (const mailbox of MAILBOXES) expect(getProviderSubmissionProviderForMailbox(mailbox)).toBe(tucowsProvider);
		expect(getProviderSubmissionProviderForRegistrarId(69)).toBe(tucowsProvider);
		expect(getProviderSubmissionProviderForRegistrarId(48)).toBe(tucowsProvider);
	});

	test("ends the route as insufficient evidence when the form cannot take the report", async () => {
		expect(await tucowsDraft.prepare({ routeId: (await tucowsRoute({ screenshot: false })).route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: "tucows_requires_a_screenshot" });
		expect(await tucowsDraft.prepare({ routeId: (await tucowsRoute({ legalBrandUrl: null })).route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: "tucows_requires_a_brand_domain" });
		expect(await tucowsDraft.prepare({ routeId: (await tucowsRoute({ allegationCategory: "malware" })).route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: "tucows_files_phishing_only" });
	});

});

describe("the draft verified before the preflight", () => {
	test("rejects a malformed, retargeted, stale or tampered-evidence draft", async () => {
		const { context, payload, route, targetId, created } = await readyContext();
		await expect(tucowsDraft.verify({ routeId: route.id, payload: {} })).rejects.toThrow("malformed");
		await expect(tucowsDraft.verify({ routeId: route.id, payload: { ...payload, report: { ...payload.report, description: `${payload.report.description} edited` } } as never })).rejects.toThrow("no longer matches the report");
		await expect(tucowsDraft.verify({ routeId: route.id, payload: { ...payload, target: { normalizedTarget: "other.example.com" } } as never })).rejects.toThrow("no longer matches its route");
		await expect(tucowsDraft.verify({ routeId: route.id, payload: { ...payload, report: { ...payload.report, reference: "PS-000000000000-R1" } } as never })).rejects.toThrow("no longer matches the report");
		(await getDb()).update(abuseArtifacts).set({ blob: Buffer.concat([PNG, Buffer.from("x")]) }).where(eq(abuseArtifacts.reportId, created.reportId)).run();
		await expect(prepareTucowsExternalSubmission(context, deps(wizard()))).rejects.toThrow("no longer matches its immutable reference");
		(await getDb()).update(abuseTargets).set({ observedUrls: [`https://${TARGET}/changed`] }).where(eq(abuseTargets.id, targetId)).run();
		await expect(tucowsDraft.verify(context)).rejects.toThrow("no longer matches the report");
	});
});

describe("the wizard before the marker", () => {
	test("walks Turnstile, code, category and the registrar check; files nothing", async () => {
		const { context } = await readyContext();
		const server = wizard();
		const preflight = await prepareTucowsExternalSubmission(context, deps(server));
		expect(preflight.dispose).toBeUndefined();
		expect(server.sent.map((request) => `${request.method} ${request.path}`)).toEqual([
			"GET /report", "POST /report",
			"GET /report/otp", "POST /report/otp", "GET /report/types",
			"GET /report/types", "POST /report/types", "GET /report/form",
			"POST /api/user/validate-field",
		]);
		const [identity, otp, category, check] = server.posts();
		expect(Object.fromEntries((identity!.body as URLSearchParams).entries())).toEqual({
			csrf_token: expect.stringMatching(/^csrf-1/), name: "Phishing Support", email: "support@phishing.support", organization: "Phishing Support", role: "it_security", "cf-turnstile-response": "turnstile-token",
		});
		expect((otp!.body as URLSearchParams).get("code")).toBe("364971");
		expect(Object.fromEntries((category!.body as URLSearchParams).entries())).toMatchObject({ category_id: "00731b3c-389e-4c7a-8df6-2c3718d4b2a9", ai_suggestion_accepted: "false" });
		expect(Object.fromEntries((check!.body as URLSearchParams).entries())).toEqual({ field_name: "offending_domain", value: TARGET });
		expect(check!.headers["x-csrf-token"]).toStartWith("csrf-");
		// Session cookies travel on every request after the first answer.
		expect(server.sent[0]!.headers.cookie).toBeUndefined();
		for (const request of server.sent.slice(1)) expect(request.headers.cookie).toBe("_swb=swb-session; csrf_token=cookie-csrf");
		expect(server.sent.some((request) => request.path === "/report/form" && request.method === "POST")).toBeFalse();
	});

	test("the code is requested after the Turnstile token and read from that moment on", async () => {
		const { context } = await readyContext();
		const server = wizard();
		const order: string[] = [];
		let requestedAt: Date | undefined;
		await prepareTucowsExternalSubmission(context, deps(server, {
			solveCaptcha: async () => { order.push("solve"); return server.expected.token; },
			readCode: async (at) => { order.push("code"); requestedAt = at; return server.expected.code; },
		}));
		expect(order).toEqual(["solve", "code"]);
		expect(requestedAt).toEqual(NOW);
	});

	test("a refused Turnstile token, wrong code or lost session is a plain retryable error with the page's text", async () => {
		const { context } = await readyContext();
		const captcha = await prepareTucowsExternalSubmission(context, deps(wizard(), { solveCaptcha: async () => "bad" })).catch((error) => error);
		expect(captcha).toBeInstanceOf(Error);
		expect(captcha.message).toContain("did not send its verification code");
		expect(captcha.message).toContain("Captcha failed");
		const code = await prepareTucowsExternalSubmission(context, deps(wizard(), { readCode: async () => "111111" })).catch((error) => error);
		expect(code.message).toContain("refused the code step");
		expect(code.message).toContain("Invalid code");
		const shape = await prepareTucowsExternalSubmission(context, deps(wizard(), { readCode: async () => "12ab" })).catch((error) => error);
		expect(shape.message).toContain("not six digits");
		for (const error of [captcha, code, shape]) {
			expect(error).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error).not.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		}
	});

	test("a page without its CSRF token, a server error or a network failure stops it", async () => {
		const { context } = await readyContext();
		await expect(prepareTucowsExternalSubmission(context, deps(wizard({ pageCsrf: false })))).rejects.toThrow("report page did not load");
		await expect(prepareTucowsExternalSubmission(context, deps(wizard(), { fetch: async () => new Response("<html>Bad gateway</html>", { status: 502 }) }))).rejects.toThrow("(HTTP 502): Bad gateway");
		await expect(prepareTucowsExternalSubmission(context, deps(wizard(), { fetch: async () => { throw new TypeError("fetch failed"); } }))).rejects.toThrow("fetch failed");
		const unexpected = (server: ReturnType<typeof wizard>) => async (url: string, init: RequestInit) => url.endsWith("/api/user/validate-field") ? new Response("nope", { status: 500 }) : server.fetch(url, init);
		const server = wizard();
		await expect(prepareTucowsExternalSubmission(context, deps(server, { fetch: unexpected(server) }))).rejects.toThrow("domain check failed (HTTP 500)");
		const garbage = wizard();
		await expect(prepareTucowsExternalSubmission(context, deps(garbage, { fetch: async (url, init) => String(url).endsWith("/api/user/validate-field") ? Response.json({ nothing: 1 }) : garbage.fetch(String(url), init ?? {}) }))).rejects.toThrow("domain check failed");
	});

	test("a domain another registrar holds ends the route for a person, naming the registrar", async () => {
		const { context } = await readyContext();
		const error = await prepareTucowsExternalSubmission(context, deps(wizard({ registrar: "MarkMonitor Inc." }))).catch((caught) => caught);
		expect(error).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(error.message).toContain(`${TARGET} is not registered through Tucows (registrar: MarkMonitor Inc.)`);
		expect(error.message).toContain("abuse@registrar.example");
	});

	test("without a mailbox it asks for a person before touching Tucows or opening a browser", async () => {
		const { context } = await readyContext();
		const saved = process.env.IMAP_HOST;
		delete process.env.IMAP_HOST;
		try {
			const server = wizard();
			let solved = 0;
			const error = await prepareTucowsExternalSubmission(context, { fetch: server.fetch, solveCaptcha: async () => { solved++; return "t"; } }).catch((caught) => caught);
			expect(error).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
			expect(error.message).toContain("IMAP mailbox");
			expect(server.sent).toHaveLength(0);
			expect(solved).toBe(0);
		} finally {
			if (saved === undefined) delete process.env.IMAP_HOST;
			else process.env.IMAP_HOST = saved;
		}
	});

	test("the worker's deadline aborts a request", async () => {
		const { context } = await readyContext();
		const controller = new AbortController();
		const fetch = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.aborted ? reject(init.signal!.reason) : init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
		const pending = prepareTucowsExternalSubmission({ ...context, signal: controller.signal }, deps(wizard(), { fetch }));
		controller.abort(new Error("deadline"));
		await expect(pending).rejects.toThrow("deadline");
	});
});

async function preflightFor(options: Parameters<typeof wizard>[0] = {}, route: Parameters<typeof readyContext>[0] = {}) {
	const ready = await readyContext(route);
	const server = wizard(options);
	const preflight = await prepareTucowsExternalSubmission(ready.context, deps(server));
	return { ...ready, server, preflight };
}

describe("submitTucowsSubmission", () => {
	test("posts the form's multipart request once and confirms with Tucows' case id", async () => {
		const { context, payload, server, preflight } = await preflightFor();
		const before = server.sent.length;
		const success = await submitTucowsSubmission(context, preflight);
		expect(success).toEqual({
			confirmationId: "FD-48213",
			confirmationText: "Tucows accepted the report (case FD-48213)",
			finalUrl: "https://bullwark.tucows.com/report",
			submittedTargets: [TARGET],
		});
		const filing = server.sent.slice(before).filter((request) => request.method === "POST");
		expect(filing).toHaveLength(1);
		expect(filing[0]!.path).toBe("/report/form");
		expect(filing[0]!.headers).toMatchObject({ origin: "https://bullwark.tucows.com", referer: "https://bullwark.tucows.com/report" });
		expect(filing[0]!.headers["content-type"]).toBeUndefined();
		const form = filing[0]!.body as FormData;
		expect([...form.keys()]).toEqual(["csrf_token", "is_domain_owner", "offending_domain", "target_group", "target_group_domain", "url", "description", "file_upload", "attest_good_faith", "attest_data_processing"]);
		expect(form.get("csrf_token")).toStartWith("csrf-");
		expect(form.get("is_domain_owner")).toBe("No");
		expect(form.get("offending_domain")).toBe(TARGET);
		expect(form.get("target_group")).toBe("Example Bank");
		expect(form.get("target_group_domain")).toBe("examplebank.com");
		expect(form.get("url")).toBe(`https://${TARGET}/signin`);
		expect(form.get("description")).toBe(payload.report.description);
		expect(form.get("attest_good_faith")).toBe("on");
		expect(form.get("attest_data_processing")).toBe("on");
		const file = form.get("file_upload") as File;
		expect(file.name).toBe(payload.evidence.filename);
		expect(file.type).toBe("image/png");
		expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBeTrue();
	});

	test("falls back to our reference when the answer names no case", async () => {
		const cases: Array<[string, () => Response]> = [
			["a redirect to the wizard's done page", () => new Response(null, { status: 303, headers: { location: "/report/thanks" } })],
			["a 200 page without a case", () => new Response("<html><h1>Thank you</h1><p>Your report was submitted.</p></html>", { status: 200 })],
			["a JSON ack", () => Response.json({ ok: true })],
			["an empty 201", () => new Response("", { status: 201 })],
		];
		for (const [name, filing] of cases) {
			const { context, payload, preflight } = await preflightFor({ filing: () => filing() });
			const success = await submitTucowsSubmission(context, preflight);
			expect(success.confirmationId, name).toBe(payload.report.reference);
			expect(success.confirmationText, name).toBe("Tucows accepted the report");
			expect(success.submittedTargets, name).toEqual([TARGET]);
		}
	});

	test("reads the case from the confirmation page, and survives that page failing", async () => {
		const { context, preflight } = await preflightFor({ filing: () => new Response(null, { status: 303, headers: { location: "/report/confirmation" } }) });
		const state = preflight.state as { session: { get(path: string): Promise<unknown> } };
		state.session.get = async () => ({ status: 200, text: "<html><p>Your case number is 987654</p></html>" });
		expect((await submitTucowsSubmission(context, preflight)).confirmationId).toBe("987654");

		const failing = await preflightFor({ filing: () => new Response(null, { status: 303, headers: { location: "/report/confirmation" } }) });
		(failing.preflight.state as { session: { get(path: string): Promise<unknown> } }).session.get = async () => { throw new Error("network"); };
		expect((await submitTucowsSubmission(failing.context, failing.preflight)).confirmationId).toBe(failing.payload.report.reference);
	});

	test("a refused request means nothing was filed", async () => {
		for (const status of [400, 413, 415, 422]) {
			const { context, preflight } = await preflightFor({ filing: () => Response.json({ error: "file too large" }, { status }) });
			const error = await submitTucowsSubmission(context, preflight).catch((caught) => caught);
			expect(error).toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error.message).toContain(`HTTP ${status}`);
		}
	});

	test("every other failure is ambiguous: a plain error, never a rejection", async () => {
		const cases: Array<[string, () => Response]> = [
			["403", () => new Response("Forbidden", { status: 403 })],
			["429", () => new Response("Too many requests", { status: 429 })],
			["500", () => new Response("boom", { status: 500 })],
			["502", () => new Response("<html>bad gateway</html>", { status: 502 })],
			["the form again with an error", () => new Response('<form><input name="offending_domain"><p>Invalid</p></form>', { status: 200 })],
			["a redirect back to the form", () => new Response(null, { status: 303, headers: { location: "/report/form" } })],
			["a redirect to the first step", () => new Response(null, { status: 303, headers: { location: "https://bullwark.tucows.com/report?expired=1" } })],
			["a redirect to another host", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })],
			["a redirect without a location", () => new Response(null, { status: 302 })],
		];
		for (const [name, filing] of cases) {
			const { context, preflight } = await preflightFor({ filing: () => filing() });
			const error = await submitTucowsSubmission(context, preflight).catch((caught) => caught);
			expect(error, name).toBeInstanceOf(Error);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		}
		const { context, preflight } = await preflightFor();
		(preflight.state as { session: { postMultipart: unknown } }).session.postMultipart = async () => { throw new TypeError("fetch failed"); };
		const network = await submitTucowsSubmission(context, preflight).catch((caught) => caught);
		expect(network).toBeInstanceOf(TypeError);
	});

	test("without its prepared wizard session nothing is sent", async () => {
		const { context } = await readyContext();
		await expect(submitTucowsSubmission(context, { state: {} })).rejects.toThrow("prepared wizard session");
		await expect(submitTucowsSubmission(context, { state: { session: {}, payload: {}, csrfToken: "x", screenshot: "not a buffer" } })).rejects.toThrow("prepared wizard session");
	});
});

describe("tucowsCaseId", () => {
	const reference = "PS-8fc84cc01019-R7";
	test("finds a Freshdesk ticket or case number in JSON, text or the path", () => {
		expect(tucowsCaseId({ text: JSON.stringify({ case_number: "TC-20931" }) }, reference)).toBe("TC-20931");
		expect(tucowsCaseId({ text: JSON.stringify({ data: { ticket_id: 48213 } }) }, reference)).toBe("48213");
		expect(tucowsCaseId({ text: JSON.stringify({ reference_number: "ABUSE-77120" }) }, reference)).toBe("ABUSE-77120");
		expect(tucowsCaseId({ text: "<p>Your case number: <b>FD-48213</b></p>" }, reference)).toBe("FD-48213");
		expect(tucowsCaseId({ text: "Ticket #123456 was created" }, reference)).toBe("123456");
		expect(tucowsCaseId({ text: "ok", location: "/report/confirmation/48213?x=1" }, reference)).toBe("48213");
	});

	test("never mistakes our own reference, prose, a bare word or an oversized token for a case", () => {
		expect(tucowsCaseId({ text: `Reference: ${reference}` }, reference)).toBeUndefined();
		expect(tucowsCaseId({ text: JSON.stringify({ id: reference }) }, reference)).toBeUndefined();
		expect(tucowsCaseId({ text: "Thank you for your report. We will respond with a case number." }, reference)).toBeUndefined();
		expect(tucowsCaseId({ text: "<script>var ticket = 99999999</script><p>done</p>" }, reference)).toBeUndefined();
		expect(tucowsCaseId({ text: JSON.stringify({ id: "x".repeat(80) }) }, reference)).toBeUndefined();
		expect(tucowsCaseId({ text: "", location: "/report/thanks" }, reference)).toBeUndefined();
		expect(tucowsCaseId({ text: "<p>Your case number is not available</p>" }, reference)).toBeUndefined();
		expect(tucowsCaseId({ text: "null" }, reference)).toBeUndefined();
	});
});

describe("executed through the worker's marker", () => {
	function asProvider(server: ReturnType<typeof wizard>): ProviderSubmissionProvider {
		const dependencies = deps(server);
		return defineProvider({
			definition: TUCOWS_PROVIDER,
			draft: tucowsDraft,
			external: { prepare: (context, verified) => rawPrepareTucowsExternalSubmission(context, verified, dependencies), submit: submitTucowsSubmission },
		});
	}

	test("submits once and settles the route with the case id; a second execution files nothing", async () => {
		const { route, created } = await tucowsRoute();
		const server = wizard();
		await expect(executeProviderSubmission({ routeId: route.id, provider: asProvider(server) })).resolves.toEqual({ outcome: "submitted", runId: expect.any(BigInt) });
		const [run] = await AbuseRepository.listProviderRunsForReport(created.reportId);
		expect(run).toMatchObject({ executionStatus: "completed", confirmationId: "FD-48213", submittedTargets: [TARGET] });
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("submitted");
		await expect(executeProviderSubmission({ routeId: route.id, provider: asProvider(server) })).resolves.toEqual({ outcome: "not_eligible" });
		expect(server.posts().filter((request) => request.path === "/report/form")).toHaveLength(1);
	});

	test("a registrar elsewhere settles needs_human before the marker; nothing is filed", async () => {
		const { route } = await tucowsRoute();
		const server = wizard({ registrar: "GoDaddy.com, LLC" });
		await expect(executeProviderSubmission({ routeId: route.id, provider: asProvider(server) })).resolves.toMatchObject({ outcome: "needs_human" });
		expect(server.posts().filter((request) => request.path === "/report/form")).toHaveLength(0);
	});

	test("a refused filing settles provider_rejected; a lost answer is ambiguous", async () => {
		const refused = await tucowsRoute();
		await expect(executeProviderSubmission({ routeId: refused.route.id, provider: asProvider(wizard({ filing: () => new Response("bad", { status: 422 }) })) })).resolves.toMatchObject({ outcome: "provider_rejected" });
		const lost = await tucowsRoute();
		await expect(executeProviderSubmission({ routeId: lost.route.id, provider: asProvider(wizard({ filing: () => new Response("boom", { status: 500 }) })) })).rejects.toThrow("HTTP 500");
	});

	test("without a screenshot the route is settled as insufficient evidence", async () => {
		const { route } = await tucowsRoute({ screenshot: false });
		await expect(executeProviderSubmission({ routeId: route.id, provider: tucowsProvider })).resolves.toMatchObject({ outcome: "insufficient_evidence" });
	});
});

describe("provider", () => {
	test("previews the message the route would send, and none for a report it cannot file", () => {
		const preview = tucowsProvider.buildReportPreview!({ target: TARGET, observedUrls: [`https://${TARGET}/signin`], description, legalBrandUrl: "https://www.examplebank.com/" });
		expect(preview).toStartWith("Reference: PS-000000000000-R0");
		expect(tucowsProvider.buildReportPreview!({ target: TARGET, observedUrls: [], description, allegationCategory: "malware", legalBrandUrl: "https://www.examplebank.com/" })).toBeUndefined();
		expect(tucowsProvider.buildReportPreview!({ target: TARGET, observedUrls: [], description })).toBeUndefined();
	});

	test("reads its mail by our reference", () => {
		expect(tucowsProvider.inboundMail?.confirmationIds?.("Re: [Case 123] Reference: PS-8fc84cc01019-R7")).toEqual(["PS-8fc84cc01019-R7"]);
		expect(TUCOWS_PROVIDER.key).toBe("tucows_bullwark");
	});
});

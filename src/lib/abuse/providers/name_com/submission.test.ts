import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { contactRoute } from "../../resolver/routes";
import { abuseProviderRoutes, abuseTargets, type AbuseArtifact } from "../../schema";
import { sha256Hex } from "../../security";
import { BrowserFormError, type BrowserFormField, type BrowserFormResponse } from "../browser_form";
import { reportReference } from "../report_reference";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { NAME_COM_PROVIDER as PROVIDER } from "./definition";
import { nameComConfirmationIds, nameComProvider } from "./index";
import { storedNameComSubmissionPayload } from "./payload";
import {
	captchaAccepted,
	csrfHandshakeHeaders,
	csrfToken,
	prepareNameComExternalSubmission,
	prepareNameComSubmission,
	submitNameComSubmission,
	ticketFields,
	verifiedNameComDraft,
	type NameComPreflightState,
	type NameComSession,
} from "./submission";

useTemporaryDatabase();

const TARGET = "login-example-phish.com";
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const png = (id: bigint, bytes = PNG) => ({ id, reportId: 1n, name: "shot.png", kind: "user_evidence_original", mimeType: "image/png", sha256: sha256Hex(bytes), size: bytes.byteLength, blob: bytes, metadata: {}, createdAt: new Date() }) as unknown as AbuseArtifact;
const TOKEN = "a".repeat(128);

async function nameRoute(options: { target?: string } = {}) {
	const target = options.target ?? TARGET;
	const request = await validateAbuseReportRequest({
		targets: [target],
		allegationCategory: "phishing",
		description,
		observedUrls: [{ target, urls: [`https://${target}/signin`] }],
		legalBrandUrl: "https://www.examplebank.com/",
	});
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [stored] = await AbuseRepository.listTargets(created.reportId);
	const route = await AbuseRepository.upsertResolvedRoute(stored!.id, contactRoute({ email: "abuse@name.com", providerName: "Name.com", provenance: {}, snapshot: {} }));
	return { created, route, targetId: stored!.id };
}

async function readyContext() {
	const fixture = await nameRoute();
	const preparation = await prepareNameComSubmission({ routeId: fixture.route.id, payload: {} });
	if (preparation.outcome !== "ready") throw new Error(`expected ready, got ${JSON.stringify(preparation)}`);
	const payload = storedNameComSubmissionPayload(preparation.payload)!;
	return { ...fixture, payload, context: { routeId: fixture.route.id, payload: payload as unknown as Record<string, unknown> } };
}

const answer = (json: unknown, status = 200): BrowserFormResponse => ({ status, text: JSON.stringify(json), json });
const CSRF_OK = { status: 200, text: '{"meta":null}', json: undefined, headers: { "x-csrf-token-auth": TOKEN } };
const VERIFY_OK = { ...answer({ meta: null, message: [], data: { account: { supportFormRecaptcha: true } } }), headers: {} };

type Call =
	| { kind: "click"; selector: string }
	| { kind: "turnstile"; widget: string | undefined }
	| { kind: "global"; path: string }
	| { kind: "request"; method: string; url: string; headers: Record<string, string> | undefined; json: unknown }
	| { kind: "post"; url: string; fields: BrowserFormField[]; headers: Record<string, string> | undefined };

type Options = {
	clicked?: number;
	turnstile?: () => Promise<string>;
	csrf?: { status: number; text: string; json: unknown; headers: Record<string, string> };
	verify?: { status: number; text: string; json: unknown; headers: Record<string, string> };
	post?: () => BrowserFormResponse | Error;
};

function fakeSession(options: Options = {}) {
	const calls: Call[] = [];
	let closed = 0;
	const session: NameComSession = {
		clickAll: async (selector) => { calls.push({ kind: "click", selector }); return options.clicked ?? 3; },
		waitForTurnstileToken: async (turnstile) => { calls.push({ kind: "turnstile", widget: turnstile?.widgetSelector }); return options.turnstile ? options.turnstile() : "0.TURNSTILE"; },
		readGlobal: async (path) => { calls.push({ kind: "global", path }); return "https://www.name.com/"; },
		request: async (init) => {
			calls.push({ kind: "request", method: init.method, url: init.url, headers: init.headers as never, json: init.json });
			return init.method === "GET" ? options.csrf ?? CSRF_OK : options.verify ?? VERIFY_OK;
		},
		readFormFields: async () => { throw new Error("not used"); },
		postForm: async (url, fields, _timeout, headers) => {
			calls.push({ kind: "post", url, fields: [...fields], headers: headers as never });
			const result = options.post?.() ?? answer({ success: true, case_id: 4711 });
			if (result instanceof Error) throw result;
			return result;
		},
		close: async () => { closed++; },
	};
	return { session, calls, closed: () => closed };
}

function fakeRoute(domain: string, evidenceArtifacts: AbuseArtifact[]) {
	return async () => ({
		route: { id: 5n, reportId: 9n, routeType: "provider_submission", providerRegistryKey: "name_com", providerDefinitionVersion: PROVIDER.version, providerDefinitionHash: PROVIDER.contentHash, routeMetadata: {} },
		report: { id: 9n, submissionId: 377486973465530391n, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/", description },
		target: { normalizedTarget: domain, targetType: "domain", observedUrls: [`https://${domain}/signin`] },
		evidenceArtifacts,
		targets: [],
	}) as never;
}

describe("registry", () => {
	test("abuse@name.com and IANA 625 resolve to the provider; nothing else claims them", async () => {
		const { getProviderSubmissionProviderForMailbox, getProviderSubmissionProviderForRegistrarId, listProviderSubmissionProviders } = await import("../submission_registry_default");
		expect(getProviderSubmissionProviderForMailbox("abuse@name.com")?.definition.key).toBe("name_com");
		expect(contactRoute({ email: "abuse@name.com", providerName: "Name.com", provenance: {}, snapshot: {} })).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "name_com" });
		expect(getProviderSubmissionProviderForRegistrarId(625)?.definition.key).toBe("name_com");
		expect(listProviderSubmissionProviders().filter((provider) => provider.definition.exactMailboxes.includes("abuse@name.com")).map((provider) => provider.definition.key)).toEqual(["name_com"]);
		expect(getProviderSubmissionProviderForMailbox("abuse@sub.name.com")).toBeUndefined();
	});

	test("its mail is read as replies matched by our reference or Zendesk's request number", () => {
		expect(nameComProvider.inboundMail).toMatchObject({ senderDomains: ["name.com"], messageKind: "reply" });
		const ids = nameComProvider.inboundMail!.confirmationIds!;
		expect(ids("[Request #4711]: Report received. Reference: PS-8fc84cc01019-R7")).toEqual(["PS-8fc84cc01019-R7", "4711"]);
		expect(nameComConfirmationIds("order #12 and request # 99")).toEqual([]);
		expect(nameComConfirmationIds("Your request #123456 was updated; request #123456 again")).toEqual(["123456"]);
	});

	test("an older draft is refreshed; a current one is not", async () => {
		const { payload } = await readyContext();
		const refresh = (candidate: Record<string, unknown>) => nameComProvider.shouldRefreshStartingPayload!({ routeId: 1n, payload: candidate } as never);
		expect(refresh(payload as never)).toBeFalse();
		expect(refresh({ ...payload, adapter: "old" })).toBeTrue();
	});

	test("the preview is the text a draft would send", async () => {
		const { payload } = await readyContext();
		const preview = nameComProvider.buildReportPreview!({ target: TARGET, observedUrls: [`https://${TARGET}/signin`], description, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/" })!;
		expect(payload.report.additional).toContain(preview.split("\n\n")[2]!);
		expect(nameComProvider.buildReportPreview!({ target: "203.0.113.7", observedUrls: [], description })).toBeUndefined();
	});
});

describe("prepareNameComSubmission (temporary database)", () => {
	test("drafts a ready payload keyed by the route's reference and rebuilds to the same draft", async () => {
		const { payload, created, route } = await readyContext();
		expect(payload.report.trackingId).toBe(reportReference(created.reportId, route.id));
		expect(payload.report.additional.startsWith(`Reference: ${payload.report.trackingId}\n\nReported URLs:\n- https://${TARGET}/signin`)).toBeTrue();
		expect((await verifiedNameComDraft({ routeId: route.id, payload: payload as never })).payload).toEqual(payload);
	});

	test("a pin mismatch, a foreign route and a non-domain target end as insufficient evidence", async () => {
		const mismatch = await nameRoute();
		(await getDb()).update(abuseProviderRoutes).set({ providerDefinitionHash: "0".repeat(64) }).where(eq(abuseProviderRoutes.id, mismatch.route.id)).run();
		expect(await prepareNameComSubmission({ routeId: mismatch.route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: "name_com_provider_definition_pin_mismatch" });
		const other = await nameRoute();
		(await getDb()).update(abuseProviderRoutes).set({ providerRegistryKey: "gname" }).where(eq(abuseProviderRoutes.id, other.route.id)).run();
		expect(await prepareNameComSubmission({ routeId: other.route.id, payload: {} })).toMatchObject({ reason: "name_com_provider_definition_pin_mismatch" });
		const ip = await nameRoute();
		(await getDb()).update(abuseTargets).set({ targetType: "ip" }).where(eq(abuseTargets.id, ip.targetId)).run();
		expect(await prepareNameComSubmission({ routeId: ip.route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: "name_com_requires_a_domain_target" });
	});

	test("a draft that drifted from its report is refused before anything opens", async () => {
		const { payload, route } = await readyContext();
		let opened = 0;
		const dependencies = { openForm: async () => { opened++; return fakeSession().session; } };
		const edited = { ...payload, report: { ...payload.report, additional: `${payload.report.additional}\n\nAlso, please wire money.` } };
		await expect(prepareNameComExternalSubmission({ routeId: route.id, payload: edited as never }, dependencies)).rejects.toThrow("no longer matches the report evidence");
		await expect(prepareNameComExternalSubmission({ routeId: route.id, payload: { ...payload, adapter: "x" } as never }, dependencies)).rejects.toThrow("malformed");
		expect(opened).toBe(0);
	});
});

describe("CSRF handshake helpers", () => {
	test("the token header is sha256(Start + Time + Start) in hex, beside Time, Start and the referrer", () => {
		const headers = csrfHandshakeHeaders("2f0c", "1763700000000", "https://www.name.com/");
		expect(headers).toEqual({
			time: "1763700000000",
			start: "2f0c",
			"x-csrf-token-auth": createHash("sha256").update("2f0c1763700000000" + "2f0c").digest("hex"),
			"referrer-override": "https://www.name.com/",
		});
		expect(headers["x-csrf-token-auth"]).toMatch(/^[0-9a-f]{64}$/);
	});

	test("csrfToken reads the response header, and refuses a 400 or a missing or odd token", () => {
		expect(csrfToken(CSRF_OK)).toBe(TOKEN);
		for (const bad of <Array<{ status: number; text: string; headers: Record<string, string> }>>[
			{ status: 400, text: '{"meta":null,"message":[],"data":[]}', headers: {} },
			{ status: 200, text: "", headers: {} },
			{ status: 200, text: "", headers: { "x-csrf-token-auth": "short" } },
			{ status: 200, text: "", headers: { "x-csrf-token-auth": `${"a".repeat(20)} b` } },
			{ status: 403, text: "x", headers: { "x-csrf-token-auth": TOKEN } },
		]) expect(() => csrfToken(bad)).toThrow("gave no token");
	});

	test("captchaAccepted needs HTTP 200 and the session flag set", () => {
		expect(captchaAccepted(VERIFY_OK)).toBeTrue();
		expect(captchaAccepted(answer({ data: { account: { supportFormRecaptcha: false } } }))).toBeFalse();
		expect(captchaAccepted(answer({ data: { account: {} } }))).toBeFalse();
		expect(captchaAccepted(answer({ data: { account: { supportFormRecaptcha: true } } }, 403))).toBeFalse();
		expect(captchaAccepted({ status: 200, text: "x", json: undefined })).toBeFalse();
	});
});

describe("prepareNameComExternalSubmission", () => {
	const draftWith = async (evidenceArtifacts: AbuseArtifact[]) => {
		const route = fakeRoute(TARGET, evidenceArtifacts);
		const prepared = await prepareNameComSubmission({ routeId: 5n, payload: {} }, { loadRouteContext: route });
		if (prepared.outcome !== "ready") throw new Error("not ready");
		return { payload: prepared.payload, route };
	};
	const run = (payload: Record<string, unknown>, route: ReturnType<typeof fakeRoute>, fake: ReturnType<typeof fakeSession>, getArtifact: () => Promise<AbuseArtifact | undefined> = async () => png(77n)) =>
		prepareNameComExternalSubmission({ routeId: 5n, payload }, { openForm: async () => fake.session, loadRouteContext: route, getArtifact: getArtifact as never });

	test("ticks the consents, waits for the token, takes the CSRF token, verifies the captcha and files nothing", async () => {
		const { payload, route } = await draftWith([png(77n)]);
		const fake = fakeSession();
		const preflight = await run(payload, route, fake);
		expect(fake.calls.map((call) => call.kind)).toEqual(["click", "turnstile", "global", "request", "request"]);
		expect(fake.calls[0]).toEqual({ kind: "click", selector: "form:has(textarea) label.n-checkbox" });
		expect(fake.calls[1]).toEqual({ kind: "turnstile", widget: PROVIDER.turnstileWidgetSelector });
		expect(fake.calls[2]).toEqual({ kind: "global", path: "document.referrer" });
		const handshake = fake.calls[3] as Extract<Call, { kind: "request" }>;
		expect([handshake.method, handshake.url]).toEqual(["GET", "https://www.name.com/csrf"]);
		const headers = handshake.headers!;
		expect(headers["x-csrf-token-auth"]).toBe(createHash("sha256").update(headers.start! + headers.time! + headers.start!).digest("hex"));
		expect(headers["referrer-override"]).toBe("https://www.name.com/");
		expect(fake.calls[4]).toEqual({ kind: "request", method: "POST", url: PROVIDER.verifyCaptchaUrl, headers: { "x-csrf-token-auth": TOKEN }, json: { supportFormRecaptcha: "0.TURNSTILE" } });
		expect(fake.calls.some((call) => call.kind === "post")).toBeFalse();
		const state = preflight.state as NameComPreflightState;
		expect(state.csrf).toBe(TOKEN);
		expect(state.file).toMatchObject({ mimeType: "image/png" });
		expect(Buffer.from(state.file!.base64, "base64").equals(PNG)).toBeTrue();
		expect(fake.closed()).toBe(0);
		await preflight.dispose!();
		expect(fake.closed()).toBe(1);
	});

	test("without a screenshot there is no file", async () => {
		const { payload, route } = await draftWith([]);
		const preflight = await run(payload, route, fakeSession());
		expect((preflight.state as NameComPreflightState).file).toBeNull();
	});

	test("every failure happens before the marker and closes the browser", async () => {
		const { payload, route } = await draftWith([png(77n)]);
		const cases: Array<[string, ReturnType<typeof fakeSession>, string]> = [
			["two checkboxes", fakeSession({ clicked: 2 }), "has 2 consent checkboxes, not 3"],
			["no checkboxes", fakeSession({ clicked: 0 }), "has 0 consent checkboxes"],
			["no token", fakeSession({ turnstile: async () => { throw new BrowserFormError("turnstile", "Name.com: Cloudflare Turnstile issued no token within 60 s"); } }), "issued no token"],
			["csrf 400", fakeSession({ csrf: { status: 400, text: '{"data":[]}', json: undefined, headers: {} } }), "gave no token (HTTP 400)"],
			["captcha refused", fakeSession({ verify: { ...answer({ message: ["bad"] }, 400), headers: {} } }), "did not accept the Turnstile token (HTTP 400)"],
			["flag not set", fakeSession({ verify: { ...answer({ data: { account: { supportFormRecaptcha: false } } }), headers: {} } }), "did not accept the Turnstile token (HTTP 200)"],
		];
		for (const [name, fake, message] of cases) {
			await expect(run(payload, route, fake), name).rejects.toThrow(message);
			expect(fake.closed(), name).toBe(1);
			expect(fake.calls.some((call) => call.kind === "post"), name).toBeFalse();
		}
		// A changed or missing screenshot is caught before a browser opens.
		const untouched = fakeSession();
		await expect(run(payload, route, untouched, async () => png(77n, Buffer.concat([PNG, Buffer.from([1])])))).rejects.toThrow("no longer matches its immutable reference");
		await expect(run(payload, route, untouched, async () => undefined)).rejects.toThrow("no longer matches its immutable reference");
		expect(untouched.calls).toEqual([]);
	});

	test("a browser that cannot pass Cloudflare's challenge is an error before the marker", async () => {
		const { payload, route } = await draftWith([]);
		await expect(prepareNameComExternalSubmission({ routeId: 5n, payload }, {
			loadRouteContext: route,
			openForm: async () => { throw new BrowserFormError("challenge", "Name.com: the Cloudflare challenge was not passed within 60 s"); },
		})).rejects.toThrow("Cloudflare challenge was not passed");
	});
});

describe("submitNameComSubmission", () => {
	const FILE = { filename: "shot.png", mimeType: "image/png", base64: PNG.toString("base64") };
	async function prepared(post?: () => BrowserFormResponse | Error, file: NameComPreflightState["file"] = FILE) {
		const { context, payload } = await readyContext();
		const fake = fakeSession(post ? { post } : {});
		const state: NameComPreflightState = { session: fake.session, csrf: TOKEN, file };
		return { context, payload, fake, preflight: { state } };
	}

	test("posts exactly the form's parts in the bundle's order, with the CSRF header, and settles on the case id", async () => {
		const { context, payload, fake, preflight } = await prepared();
		const success = await submitNameComSubmission(context, preflight);
		expect(success).toEqual({
			confirmationId: "4711",
			confirmationText: `Name.com accepted the report as case 4711 (our reference ${payload.report.trackingId})`,
			finalUrl: PROVIDER.formUrl,
			submittedTargets: [TARGET],
		});
		expect(fake.calls).toHaveLength(1);
		const post = fake.calls[0] as Extract<Call, { kind: "post" }>;
		expect(post.url).toBe("https://www.name.com/ajax/zendeskticket/create/");
		expect(post.headers).toEqual({ "x-csrf-token-auth": TOKEN });
		expect(post.fields).toEqual([
			["form-type", "report_abuse_spa"],
			["firstname", "Phishing"],
			["lastname", "Support"],
			["email", "support@phishing.support"],
			["attachment", FILE],
			["domain_name", TARGET],
			["typeofinfringement", "Phishing"],
			["additional", payload.report.additional],
			["iagree", "on"],
			["maynotrespond", "on"],
			["iagree", "on"],
		]);
	});

	test("a string case id, and an answer wrapped in data, are read; no file means no attachment part", async () => {
		const wrapped = await prepared(() => answer({ data: { success: true, case_id: "ABC-12" } }), null);
		expect(await submitNameComSubmission(wrapped.context, wrapped.preflight)).toMatchObject({ confirmationId: "ABC-12" });
		expect((wrapped.fake.calls[0] as Extract<Call, { kind: "post" }>).fields.map(([name]) => name)).toEqual(["form-type", "firstname", "lastname", "email", "domain_name", "typeofinfringement", "additional", "iagree", "maynotrespond", "iagree"]);
		expect(ticketFields({ target: { domain: "d" }, report: { additional: "a" } } as never, null)).toHaveLength(10);
	});

	test("a plain refusal (400/422, success false, a message) is a rejection", async () => {
		for (const status of [400, 422]) {
			const { context, preflight } = await prepared(() => answer({ success: false, message: "Invalid domain name." }, status));
			const error = await submitNameComSubmission(context, preflight).catch((caught) => caught);
			expect(error).toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error.message).toBe(`Name.com refused the report (HTTP ${status}): Invalid domain name.`);
		}
	});

	test("a bot or captcha verdict filed nothing and goes to a person", async () => {
		for (const message of ["Captcha verification failed.", "Suspected spam submission", "Please verify you are human"]) {
			const { context, preflight } = await prepared(() => answer({ success: false, message }, 400));
			const error = await submitNameComSubmission(context, preflight).catch((caught) => caught);
			expect(error, message).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		}
	});

	test("everything else is ambiguous, never a rejection", async () => {
		const cases: Array<[string, BrowserFormResponse | Error]> = [
			["success without a case id", answer({ success: true })],
			["success with a bad case id", answer({ success: true, case_id: "a b" })],
			["failure with HTTP 200", answer({ success: false, message: "Sorry, there was an error submitting your form." })],
			["failure without message", answer({ success: false }, 400)],
			["HTTP 500 with a failure body", answer({ success: false, message: "boom" }, 500)],
			["case id without success", answer({ case_id: 4711 })],
			["csrf 403", { status: 403, text: "<html>Just a moment...</html>", json: undefined }],
			["429", { status: 429, text: "slow down", json: undefined }],
			["non-JSON 200", { status: 200, text: "<html>ok</html>", json: undefined }],
			["json null", answer(null)],
			["request failed", new BrowserFormError("request", "Name.com: the request to /ajax/zendeskticket/create/ failed (Failed to fetch)")],
		];
		for (const [name, result] of cases) {
			const { context, preflight } = await prepared(() => result);
			const error = await submitNameComSubmission(context, preflight).catch((caught) => caught);
			expect(error, name).toBeInstanceOf(Error);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		}
		const { context, preflight } = await prepared(() => answer({ success: true }));
		await expect(submitNameComSubmission(context, preflight)).rejects.toThrow("HTTP 200 and success without a case id");
	});

	test("never runs without the preflight's session and CSRF token, or on a malformed draft", async () => {
		const { context, fake, preflight } = await prepared();
		await expect(submitNameComSubmission(context, undefined)).rejects.toThrow("requires its prepared browser session");
		await expect(submitNameComSubmission(context, { state: { ...preflight.state, csrf: "" } })).rejects.toThrow("requires its prepared browser session");
		await expect(submitNameComSubmission({ ...context, payload: { ...context.payload, adapter: "x" } }, preflight)).rejects.toThrow("malformed");
		expect(fake.calls).toEqual([]);
		await expect(nameComProvider.submit(context)).rejects.toThrow("requires its prepared browser session");
	});
});

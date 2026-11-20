import { describe, expect, test } from "bun:test";

import { PREVIEW_REFERENCE, defineProvider, registrarPreview } from "./provider";
import { failUnlessFiled, deadline, jsonRecord } from "./http";
import { preparedState, withPreflight } from "./session";
import { composeFreeText, isReportUrl, reportUrls, snippet } from "./text";
import { ProviderSubmissionRejectedError, type ProviderSubmissionContext } from "../submission_contracts";
import { definePinned } from "./pin";

const HOST = "phish.example.com";
const url = (path: string) => `https://${HOST}/${path}`;

describe("reportUrls", () => {
	test("keeps the target's own URLs once each, in order, and drops what is not theirs", () => {
		const urls = reportUrls(HOST, [url("a"), "https://other.example.org/b", url("a"), "not a url", url("c")], { maximumLength: 200 });
		expect(urls).toEqual([url("a"), url("c")]);
	});

	test("stops at the maximum count and at the character budget, each URL costing its newline and bullet", () => {
		const observed = [url("a"), url("b"), url("c"), url("d")];
		expect(reportUrls(HOST, observed, { maximumLength: 200, maximum: 2 })).toEqual([url("a"), url("b")]);
		const cost = url("a").length + 3;
		expect(reportUrls(HOST, observed, { maximumLength: 200, budget: cost * 3 })).toEqual([url("a"), url("b"), url("c")]);
		expect(reportUrls(HOST, observed, { maximumLength: 200, budget: cost * 3 - 1 })).toEqual([url("a"), url("b")]);
		// A URL that does not fit is skipped, a shorter later one still can.
		expect(reportUrls(HOST, [url("a".repeat(30)), url("b")], { maximumLength: 200, budget: url("b").length + 3 })).toEqual([url("b")]);
	});

	test("falls back to the host's root unless the rules forbid it", () => {
		expect(reportUrls(HOST, [], { maximumLength: 200 })).toEqual([`https://${HOST}/`]);
		expect(reportUrls(HOST, ["https://other.example.org/"], { maximumLength: 200 })).toEqual([`https://${HOST}/`]);
		expect(reportUrls(HOST, [], { maximumLength: 200, rootFallback: false })).toEqual([]);
		expect(reportUrls(HOST, [], { maximumLength: 5 })).toEqual([]);
	});
});

describe("isReportUrl", () => {
	const rules = { maximumLength: 40, minimumLength: 20 };
	test("accepts exactly what the builders write: public, normalised, within the length rules", () => {
		expect(isReportUrl(url("login"), rules)).toBeTrue();
		expect(isReportUrl("https://a.io/", rules)).toBeFalse();
		expect(isReportUrl(url("x".repeat(40)), rules)).toBeFalse();
		expect(isReportUrl(`https://${HOST}/a b`, rules)).toBeFalse();
		expect(isReportUrl(`HTTPS://${HOST.toUpperCase()}/login`, rules)).toBeFalse();
		expect(isReportUrl("http://127.0.0.1/login-page-here", rules)).toBeFalse();
		expect(isReportUrl(42, rules)).toBeFalse();
	});

	test("a rule may allow what whitespace would otherwise forbid", () => {
		expect(isReportUrl(`https://${HOST}/a%20b`, { maximumLength: 200, forbidden: /[<>]/ })).toBeTrue();
	});
});

describe("composeFreeText", () => {
	const input = { target: HOST, observedUrls: [url("a")], description: "The page asks visitors for a password and a verification code.", allegationCategory: "phishing", trackingId: "PS-000000000000-R0" };
	const base = { provider: "generic" as const, input, urls: [url("a")], before: ["Reference: PS-000000000000-R0"], hostingLimit: 100 };

	test("with a maximum the narrative has that room, then the hosting line and the case page follow", () => {
		const text = composeFreeText({ ...base, input: { ...input, hostingLine: "Hosted at 203.0.113.7 (Example AS)", caseUrl: "https://phishing.support/submissions/1" }, limit: 5_000, narrative: { maximum: 400 } })!;
		expect(text.startsWith("Reference: PS-000000000000-R0\n\n")).toBeTrue();
		expect(text.endsWith("Case details and screenshots: https://phishing.support/submissions/1")).toBeTrue();
		expect(text).toContain("Hosted at 203.0.113.7 (Example AS)");
		expect(composeFreeText({ ...base, limit: 100, narrative: { maximum: 400 } })).toBeUndefined();
	});

	test("with a minimum the narrative takes what the other parts leave and the report is not drafted below it", () => {
		const roomy = composeFreeText({ ...base, limit: 1_000, narrative: { minimum: 100 } })!;
		expect(roomy.length).toBeLessThanOrEqual(1_000);
		const snug = composeFreeText({ ...base, limit: 400, narrative: { minimum: 100 } })!;
		expect(snug.length).toBeLessThanOrEqual(400);
		expect(snug.length).toBeLessThan(roomy.length);
		// The reference alone leaves 400 - 29 - 2 * 2 = 367 characters; a minimum above that cannot be met.
		expect(composeFreeText({ ...base, limit: 400, narrative: { minimum: 368 } })).toBeUndefined();
		expect(composeFreeText({ ...base, limit: 400, narrative: { minimum: 367 } })).toBeDefined();
	});
});

describe("failUnlessFiled", () => {
	test("a listed status is a refusal, nothing filed", () => {
		expect(() => failUnlessFiled("Acme", { status: 400, ok: false }, "bad field", [400, 422])).toThrow(ProviderSubmissionRejectedError);
		expect(() => failUnlessFiled("Acme", { status: 422, ok: false }, "bad field", [400, 422])).toThrow("Acme refused the report (HTTP 422): bad field");
	});

	test("any other failure leaves it open whether the provider kept the report", () => {
		for (const status of [401, 429, 500, 504]) {
			const error = (() => { try { failUnlessFiled("Acme", { status, ok: false }, "gateway", [400]); } catch (caught) { return caught as Error; } })();
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error!.message).toBe(`Acme answered the report with HTTP ${status}: gateway`);
		}
	});

	test("a successful answer passes, even with a refusal list", () => {
		expect(() => failUnlessFiled("Acme", { status: 200, ok: true }, "", [400])).not.toThrow();
	});
});

describe("http and text helpers", () => {
	test("jsonRecord takes only a JSON object", () => {
		expect(jsonRecord('{"a":1}')).toEqual({ a: 1 });
		for (const text of ["[1]", "3", '"x"', "null", "not json", ""]) expect(jsonRecord(text), text).toBeUndefined();
	});

	test("snippet flattens whitespace and keeps its cap", () => {
		expect(snippet("  a\n\n b\t c ")).toBe("a b c");
		expect(snippet("x".repeat(400))).toHaveLength(300);
		expect(snippet("x".repeat(400), 500)).toHaveLength(400);
	});

	test("deadline aborts on its own timeout and on the worker's signal", async () => {
		expect(deadline(60_000).aborted).toBeFalse();
		const worker = new AbortController();
		const signal = deadline(60_000, worker.signal);
		worker.abort(new Error("cancelled"));
		expect(signal.aborted).toBeTrue();
		await expect(Bun.sleep(30).then(() => deadline(10).aborted)).resolves.toBeFalse();
		const short = deadline(5);
		await Bun.sleep(30);
		expect(short.aborted).toBeTrue();
	});
});

describe("session helpers", () => {
	test("withPreflight hands the prepared state over with a disposer that closes the session", async () => {
		let closed = 0;
		const preflight = await withPreflight(async () => ({ close: async () => { closed += 1; } }), async () => ({ ready: true }));
		expect(preflight.state).toEqual({ ready: true });
		expect(closed).toBe(0);
		await preflight.dispose!();
		expect(closed).toBe(1);
	});

	test("withPreflight closes the session first when preparing fails, and rethrows", async () => {
		let closed = 0;
		await expect(withPreflight(async () => ({ close: async () => { closed += 1; } }), async () => { throw new Error("upload failed"); })).rejects.toThrow("upload failed");
		expect(closed).toBe(1);
	});

	test("preparedState returns a complete state and refuses a missing or incomplete one with the provider's own message", () => {
		const complete = (state: { code?: string }) => !!state.code;
		expect(preparedState<{ code?: string }>({ state: { code: "123456" } }, complete, "needs a code")).toEqual({ code: "123456" });
		expect(() => preparedState(undefined, complete, "needs a code")).toThrow("needs a code");
		expect(() => preparedState({ state: undefined }, complete, "needs a code")).toThrow("needs a code");
		expect(() => preparedState({ state: {} }, complete, "needs a code")).toThrow("needs a code");
	});
});

describe("registrarPreview", () => {
	const preview = registrarPreview({
		urls: (domain, observedUrls) => reportUrls(domain, observedUrls, { maximumLength: 200, rootFallback: false }),
		make: (input, urls) => `${input.trackingId} ${input.target} ${urls.join(",")} ${input.allegationCategory ?? "-"} ${input.legalBrandUrl ?? "-"}`,
	});
	const context = { target: HOST, observedUrls: [url("a")], description: "A page." };

	test("previews a domain's listed URLs under the stand-in reference", () => {
		expect(preview({ ...context, allegationCategory: "phishing", legalBrandUrl: "https://bank.example/" })).toBe(`${PREVIEW_REFERENCE} ${HOST} ${url("a")} phishing https://bank.example/`);
		expect(preview(context)).toBe(`${PREVIEW_REFERENCE} ${HOST} ${url("a")} - -`);
	});

	test("has no preview for a target that is no domain or lists no URL", () => {
		expect(preview({ ...context, target: "not a domain" })).toBeUndefined();
		expect(preview({ ...context, observedUrls: [] })).toBeUndefined();
	});
});

describe("defineProvider", () => {
	const definition = definePinned({ key: "kit_test", displayName: "Kit Test", version: "v1", exactMailboxes: [], supplemental: false });
	const draft = { prepare: async () => ({ outcome: "insufficient_evidence", reason: "x" }) as const, verify: async () => undefined };
	const context: ProviderSubmissionContext = { routeId: 1n, payload: {} };
	const success = { submittedTargets: ["x"] };

	test("a provider without any submit call cannot be defined", () => {
		expect(() => defineProvider({ definition, draft })).toThrow("kit_test has no submit call.");
	});

	test("the draft pair becomes the executor's prepare and verify, and a plain submit is the only call", async () => {
		const provider = defineProvider({ definition, draft, submit: async () => success });
		expect(provider.prepareSubmission).toBe(draft.prepare);
		expect(provider.verifyDraft).toBe(draft.verify);
		expect(provider.prepareExternalSubmission).toBeUndefined();
		expect(provider.submitPrepared).toBeUndefined();
		await expect(provider.submit(context)).resolves.toBe(success);
	});

	test("a form provider's external pair fills the preflight hooks, and the plain submit has no preflight", async () => {
		const seen: unknown[] = [];
		const provider = defineProvider({
			definition,
			draft,
			external: { prepare: async () => ({ state: 1 }), submit: async (_context, preflight) => { seen.push(preflight); return success; } },
		});
		expect(provider.prepareExternalSubmission).toBeDefined();
		await provider.submit(context);
		await provider.submitPrepared!(context, { state: 2 });
		expect(seen).toEqual([undefined, { state: 2 }]);
	});

	test("inbound mail defaults to our references and may name its own matcher, never a default kind", () => {
		const defaults = defineProvider({ definition, draft, submit: async () => success, inbound: { senderDomains: ["kit.example"] } });
		expect(defaults.inboundMail!.confirmationIds!("see PS-000000000000-R0")).toEqual(["PS-000000000000-R0"]);
		expect(defaults.inboundMail!.messageKind).toBeUndefined();
		const own = defineProvider({ definition, draft, submit: async () => success, inbound: { senderDomains: ["kit.example"], messageKind: "reply", confirmationIds: () => ["X"] } });
		expect(own.inboundMail).toMatchObject({ messageKind: "reply" });
		expect(own.inboundMail!.confirmationIds!("")).toEqual(["X"]);
		expect(defineProvider({ definition, draft, submit: async () => success }).inboundMail).toBeUndefined();
	});
});

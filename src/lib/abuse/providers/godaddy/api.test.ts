import { describe, expect, test } from "bun:test";

import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { fetchGoDaddyTicket, fileGoDaddyTicket, fileGoDaddyTickets, goDaddyApiCredentials, goDaddyApiEnabled, type GoDaddyFetch } from "./api";

const credentials = { key: "KEY", secret: "SECRET" };
type Answer = { status: number; body?: unknown; raw?: string } | Error;

function scripted(...answers: Answer[]) {
	const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
	const fetch: GoDaddyFetch = async (url, init) => {
		calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined });
		const answer = answers.shift() ?? new Error("unexpected call");
		if (answer instanceof Error) throw answer;
		const text = answer.raw ?? (answer.body === undefined ? "" : JSON.stringify(answer.body));
		return { status: answer.status, text: async () => text };
	};
	return { fetch, calls };
}

describe("goDaddyApiCredentials", () => {
	test("needs both halves, trimmed", () => {
		expect(goDaddyApiCredentials({ GODADDY_ABUSE_API_KEY: " k ", GODADDY_ABUSE_API_SECRET: "s" })).toEqual({ key: "k", secret: "s" });
		expect(goDaddyApiCredentials({ GODADDY_ABUSE_API_KEY: "k" })).toBeUndefined();
		expect(goDaddyApiCredentials({ GODADDY_ABUSE_API_KEY: "k", GODADDY_ABUSE_API_SECRET: "  " })).toBeUndefined();
		expect(goDaddyApiCredentials({})).toBeUndefined();
	});
});

describe("goDaddyApiEnabled", () => {
	test("a read with the sso-key header: 200 enabled, 401/403 not enabled, anything else an error", async () => {
		const ok = scripted({ status: 200, body: [] });
		expect(await goDaddyApiEnabled(credentials, { fetch: ok.fetch })).toBeTrue();
		expect(ok.calls[0]).toMatchObject({ url: "https://api.godaddy.com/v2/abuse/tickets?limit=1", method: "GET", headers: { authorization: "sso-key KEY:SECRET" } });
		for (const status of [401, 403]) expect(await goDaddyApiEnabled(credentials, { fetch: scripted({ status, body: { message: "Unable to complete your request at this time" } }).fetch })).toBeFalse();
		for (const status of [429, 500, 503, 404]) await expect(goDaddyApiEnabled(credentials, { fetch: scripted({ status }).fetch })).rejects.toThrow(`HTTP ${status}`);
		await expect(goDaddyApiEnabled(credentials, { fetch: scripted(new Error("socket hang up")).fetch })).rejects.toThrow("socket hang up");
	});
});

describe("fileGoDaddyTicket", () => {
	const ticket = { type: "PHISHING" as const, source: "https://a.example/login", target: "ExampleBank", info: "Reference: PS-8fc84cc01019-R7\n\ntext", infoUrl: "https://phishing.support/submissions/1" };

	test("posts the documented body and returns the u_number", async () => {
		const { fetch, calls } = scripted({ status: 201, body: { u_number: "DCU12345678" } });
		expect(await fileGoDaddyTicket(credentials, ticket, { fetch })).toEqual({ kind: "filed", ticketId: "DCU12345678" });
		expect(calls[0]).toMatchObject({ url: "https://api.godaddy.com/v2/abuse/tickets", method: "POST", headers: { "content-type": "application/json", authorization: "sso-key KEY:SECRET" }, body: ticket });
	});

	test("bounds the free text and target to the API's limits", async () => {
		const { fetch, calls } = scripted({ status: 201, body: { u_number: "DCU12345678" } });
		await fileGoDaddyTicket(credentials, { ...ticket, info: "i".repeat(30_000), target: "t".repeat(3_000) }, { fetch });
		expect([calls[0]!.body.info.length, calls[0]!.body.target.length]).toEqual([20_050, 2_000]);
	});

	test("400/422 refuse and 401/403 mean not enabled: both prove nothing was filed", async () => {
		expect(await fileGoDaddyTicket(credentials, ticket, { fetch: scripted({ status: 422, body: { message: "An open ticket for the same source exists" } }).fetch })).toEqual({ kind: "refused", message: "HTTP 422: An open ticket for the same source exists" });
		expect(await fileGoDaddyTicket(credentials, ticket, { fetch: scripted({ status: 400, raw: "bad" }).fetch })).toEqual({ kind: "refused", message: "HTTP 400: bad" });
		expect(await fileGoDaddyTicket(credentials, ticket, { fetch: scripted({ status: 403, body: { message: "Unable to complete your request at this time" } }).fetch })).toMatchObject({ kind: "not_enabled" });
		expect(await fileGoDaddyTicket(credentials, ticket, { fetch: scripted({ status: 401 }).fetch })).toMatchObject({ kind: "not_enabled", message: "HTTP 401: " });
	});

	test("429, 5xx, a 201 without a ticket and a dropped connection are ambiguous", async () => {
		for (const answer of [{ status: 429 }, { status: 500 }, { status: 502, raw: "<html>" }, { status: 201, body: {} }, { status: 201, body: { u_number: "x; drop" } }, { status: 200, body: { u_number: "DCU12345678" } }] as Answer[]) {
			const error = await fileGoDaddyTicket(credentials, ticket, { fetch: scripted(answer).fetch }).catch((caught) => caught);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(ProviderSubmissionRejectedError);
		}
		await expect(fileGoDaddyTicket(credentials, ticket, { fetch: scripted(new Error("timeout")).fetch })).rejects.toThrow("timeout");
	});
});

describe("fileGoDaddyTickets", () => {
	const base = { type: "PHISHING" as const, target: "B", info: "Reference: PS-8fc84cc01019-R7\n\nx" };
	const urls = ["https://a.example/1", "https://a.example/2", "https://a.example/3"];
	const created = (n: number): Answer => ({ status: 201, body: { u_number: `DCU1234567${n}` } });

	test("one ticket per URL, in order, each with its own source", async () => {
		const { fetch, calls } = scripted(created(1), created(2), created(3));
		expect(await fileGoDaddyTickets(credentials, urls, base, { fetch })).toEqual({ ticketIds: ["DCU12345671", "DCU12345672", "DCU12345673"], skipped: [], unfiled: [] });
		expect(calls.map((call) => call.body.source)).toEqual(urls);
	});

	test("the first URL alone decides: a refusal is rejected, 403 needs a person, ambiguity stays ambiguous", async () => {
		const rejected = await fileGoDaddyTickets(credentials, urls, base, { fetch: scripted({ status: 422, body: { message: "open ticket for same source" } }).fetch }).catch((caught) => caught);
		expect(rejected).toBeInstanceOf(ProviderSubmissionRejectedError);
		expect(rejected.message).toContain("https://a.example/1");
		expect(await fileGoDaddyTickets(credentials, urls, base, { fetch: scripted({ status: 403 }).fetch }).catch((caught) => caught)).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		const ambiguous = await fileGoDaddyTickets(credentials, urls, base, { fetch: scripted({ status: 503 }).fetch }).catch((caught) => caught);
		expect(ambiguous).toBeInstanceOf(Error);
		expect(ambiguous).not.toBeInstanceOf(ProviderSubmissionRejectedError);
	});

	test("once a ticket exists, later refusals are skipped and later trouble stops with the rest unfiled", async () => {
		expect(await fileGoDaddyTickets(credentials, urls, base, { fetch: scripted(created(1), { status: 422, body: { message: "dup" } }, created(3)).fetch })).toEqual({ ticketIds: ["DCU12345671", "DCU12345673"], skipped: [urls[1]!], unfiled: [] });
		expect(await fileGoDaddyTickets(credentials, urls, base, { fetch: scripted(created(1), { status: 429 }).fetch })).toEqual({ ticketIds: ["DCU12345671"], skipped: [], unfiled: [urls[1]!, urls[2]!] });
		expect(await fileGoDaddyTickets(credentials, urls, base, { fetch: scripted(created(1), new Error("reset")).fetch })).toEqual({ ticketIds: ["DCU12345671"], skipped: [], unfiled: [urls[1]!, urls[2]!] });
		expect(await fileGoDaddyTickets(credentials, urls, base, { fetch: scripted(created(1), created(2), { status: 403 }).fetch })).toEqual({ ticketIds: ["DCU12345671", "DCU12345672"], skipped: [], unfiled: [urls[2]!] });
		expect(await fileGoDaddyTickets(credentials, urls, base, { fetch: scripted(created(1), { status: 401 }, created(3)).fetch })).toEqual({ ticketIds: ["DCU12345671"], skipped: [], unfiled: [urls[1]!, urls[2]!] });
	});
});

describe("fetchGoDaddyTicket", () => {
	test("reads closed and closeReason; 404 and 403 mean not this reporter's; others throw", async () => {
		const { fetch, calls } = scripted({ status: 200, body: { ticketId: "DCU12345678", closed: true, closeReason: "actioned" } }, { status: 200, body: { closed: false } });
		expect(await fetchGoDaddyTicket(credentials, "DCU12345678", { fetch })).toEqual({ closed: true, closeReason: "actioned" });
		expect(calls[0]!.url).toBe("https://api.godaddy.com/v2/abuse/tickets/DCU12345678");
		expect(await fetchGoDaddyTicket(credentials, "DCU12345678", { fetch })).toEqual({ closed: false });
		for (const status of [404, 403, 401]) expect(await fetchGoDaddyTicket(credentials, "DCU1", { fetch: scripted({ status }).fetch })).toBeUndefined();
		await expect(fetchGoDaddyTicket(credentials, "DCU1", { fetch: scripted({ status: 500 }).fetch })).rejects.toThrow("HTTP 500");
		await expect(fetchGoDaddyTicket(credentials, "DCU1", { fetch: scripted({ status: 200, body: {} }).fetch })).rejects.toThrow("HTTP 200");
	});
});

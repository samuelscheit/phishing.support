import { describe, expect, test } from "bun:test";
import { browserUserAgent } from "../../../network/service_identity";

import { useTemporaryDatabase } from "../../../db/test_helpers";
import { readyDraft, verifiedPrepare } from "../kit/testing";

import { ProviderSubmissionDuplicateError, ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { buildCloudflareApiBody, cloudflareApiConfig, cloudflareDuplicateOfRejection, cloudflareReportsUrl, CloudflareSessionExpiredError, parseCloudflareApiResponse, submitCloudflareAbuseReport } from "./api";
import type { CloudflareReportPayload } from "./report";
import { retryDelayMs } from "../../worker/retry";
import { ProviderLoginUnavailableError } from "../login_session/session";
import { findCloudflareSubmission, prepareCloudflareExternalSubmission as rawPrepareCloudflareExternalSubmission, cloudflareDraft, storedCloudflareSubmissionPayload, submitCloudflareSubmission } from "./submission";

const prepareCloudflareExternalSubmission = verifiedPrepare(cloudflareDraft, rawPrepareCloudflareExternalSubmission);

useTemporaryDatabase();

const ACCOUNT_ID = "b9077acfb4ef45e0f94b0f52c06c289a";
const environment = { ABUSE_CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, ABUSE_CLOUDFLARE_LOGIN_EMAIL: "operator@example.com", ABUSE_CLOUDFLARE_LOGIN_PASSWORD: "test-password" };
const config = { accountId: ACCOUNT_ID, email: "operator@example.com", password: "test-password" };
const session = { id: "old-atok", atok: "old-atok", vses2: "test-cookie", expiresAt: Date.now() + 86_400_000 };
const fresh = { ...session, id: "fresh-atok", atok: "fresh-atok", vses2: "fresh-cookie" };
const report: CloudflareReportPayload = {
	name: "Phishing Support", email: "support@phishing.support", company: "https://phishing.support/",
	urls: "https://phishing.example/collect", justification: "The page harvests credentials.",
	originalWork: "https://brand.example/", reportedCountry: "DE",
};
const context = { accountId: ACCOUNT_ID, target: "phishing.example" };
const success = () => new Response(JSON.stringify({ abuse_rand: "r-1", result: "success" }), { status: 200 });
const expired = () => new Response(JSON.stringify({ result: "error", err_code: 9300, msg: "Authentication error" }), { status: 403 });

describe("Cloudflare dashboard API", () => {
	test("requires account and dashboard credentials, never a bearer token", () => {
		expect(cloudflareApiConfig(environment)).toEqual(config);
		for (const key of Object.keys(environment)) {
			expect(() => cloudflareApiConfig({ ...environment, [key]: " " })).toThrow(key);
		}
		expect(cloudflareReportsUrl(ACCOUNT_ID)).toBe(`https://dash.cloudflare.com/api/v4/accounts/${ACCOUNT_ID}/abuse-reports/abuse_phishing`);
	});

	test("maps report fields without browser attestation or tokens", () => {
		expect(buildCloudflareApiBody(report)).toEqual({
			act: "abuse_phishing", name: report.name, email: report.email, email2: report.email,
			company: report.company, urls: report.urls, justification: report.justification,
			original_work: report.originalWork, reported_country: "DE", host_notification: "send-anon", owner_notification: "send-anon",
		});
		const { originalWork: _unused, ...withoutBrand } = report;
		expect(buildCloudflareApiBody(withoutBrand)).not.toHaveProperty("original_work");
	});

	test("requires both success and a nonempty abuse_rand receipt", () => {
		expect(parseCloudflareApiResponse(200, JSON.stringify({ result: "success", abuse_rand: "receipt" }), context)).toEqual({
			confirmationId: "receipt", confirmationText: "Cloudflare accepted the phishing abuse report.",
			finalUrl: `https://dash.cloudflare.com/${ACCOUNT_ID}/abuse-reports/submitted`, submittedTargets: ["phishing.example"],
		});
		for (const body of ["<html>", "{}", '{"result":"success"}', '{"result":"success","abuse_rand":" "}']) {
			expect(() => parseCloudflareApiResponse(200, body, context)).toThrow();
		}
	});

	test("distinguishes explicit expired sessions from other 4xx rejections", () => {
		for (const body of [{ err_code: 9300 }, { err_code: "9300" }, { errors: [{ code: 9300 }] }]) {
			expect(() => parseCloudflareApiResponse(403, JSON.stringify(body), context)).toThrow(CloudflareSessionExpiredError);
		}
		for (const status of [400, 401, 403, 405, 422, 429]) {
			expect(() => parseCloudflareApiResponse(status, '{"result":"error","msg":"bad justification","err_code":"bad_just"}', context)).toThrow(ProviderSubmissionRejectedError);
		}
		expect(() => parseCloudflareApiResponse(200, '{"result":"error","msg":"bad justification","err_code":"bad_just"}', context)).toThrow("bad justification");
		try { parseCloudflareApiResponse(503, '{"result":"error","msg":"upstream"}', context); } catch (error) {
			expect(error).not.toBeInstanceOf(ProviderSubmissionRejectedError);
		}
	});

	test("reads exactly Cloudflare's duplicate answer as already reported, every other 4xx as a rejection", () => {
		const duplicate = `You have already submitted this URL recently: ${report.urls}`;
		for (const body of [{ result: "error", msg: duplicate }, { success: false, errors: [{ code: 1000, message: duplicate }] }]) {
			const error = (() => { try { parseCloudflareApiResponse(400, JSON.stringify(body), context); } catch (caught) { return caught; } })();
			expect(error).toBeInstanceOf(ProviderSubmissionDuplicateError);
			expect(error).toMatchObject({
				urls: [report.urls],
				receipt: { confirmationText: `Cloudflare already had a recent report for ${report.urls}.`, finalUrl: `https://dash.cloudflare.com/${ACCOUNT_ID}/abuse-reports/submitted`, submittedTargets: [context.target] },
			});
		}
		for (const [status, msg] of [
			[400, "You have already submitted this URL recently"],
			[400, "You have already submitted this URL recently: "],
			[400, `Note: You have already submitted this URL recently: ${report.urls}`],
			[400, `${duplicate} and another`],
			[400, "You have already submitted this URL recently: not-a-url"],
			[429, duplicate],
			[403, duplicate],
		] as const) {
			const error = (() => { try { parseCloudflareApiResponse(status, JSON.stringify({ result: "error", msg }), context); } catch (caught) { return caught; } })();
			expect(error).toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error).not.toBeInstanceOf(ProviderSubmissionDuplicateError);
		}
		// A run rejected before duplicates were recognised, exactly as production recorded it.
		expect(cloudflareDuplicateOfRejection(`Cloudflare abuse report was rejected with HTTP 400: ${duplicate}`, context)?.urls).toEqual([report.urls]);
		for (const reason of [`Cloudflare abuse report was rejected with HTTP 429: ${duplicate}`, "Cloudflare abuse report was rejected with HTTP 400: bad justification", duplicate]) {
			expect(cloudflareDuplicateOfRejection(reason, context)).toBeUndefined();
		}
	});

	test("a duplicate answer adopts the account's newest earlier report of exactly that URL", async () => {
		const requests: string[] = [];
		const answer = (reports: { id: string; cdate: string; urls: string[] }[], listing = true) => async (url: string, init?: RequestInit) => {
			requests.push(`${init?.method} ${url.replace(/^.*\/abuse-reports/, "")}`);
			if (init?.method === "POST") return Response.json({ result: "error", msg: `You have already submitted this URL recently: ${report.urls}` }, { status: 400 });
			if (!listing) throw new Error("listing unavailable");
			if (url.includes("/submitted?")) return Response.json({ success: true, result: { reports: reports.map(({ id, cdate }) => ({ id, cdate, domain: context.target })) } });
			const found = reports.find((candidate) => url.endsWith(candidate.id))!;
			return Response.json({ success: true, result: { id: found.id, urls: found.urls, justification: "an older justification" } });
		};
		const reports = [
			{ id: "1111111111111111", cdate: "2026-11-01T00:00:00Z", urls: [report.urls] },
			{ id: "2222222222222222", cdate: "2026-11-10T00:00:00Z", urls: [report.urls] },
			{ id: "3333333333333333", cdate: "2026-11-15T00:00:00Z", urls: ["https://phishing.example/other"] },
		];
		await expect(submitCloudflareAbuseReport({ config, session, report, target: context.target, fetch: answer(reports) })).resolves.toEqual({
			confirmationId: "2222222222222222",
			confirmationText: `Cloudflare already had a recent report for ${report.urls}. Its report 2222222222222222 in the account's submitted reports is this route's receipt.`,
			finalUrl: `https://dash.cloudflare.com/${ACCOUNT_ID}/abuse-reports/submitted`,
			submittedTargets: [context.target],
		});
		// Newest first, stopping at the first match: the oldest report is never read.
		expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(1);
		expect(requests.some((request) => request.endsWith("1111111111111111"))).toBeFalse();
		// No report in the account, or no listing, leaves the duplicate for the executor to settle.
		for (const fetch of [answer(reports.slice(2)), answer(reports, false)]) {
			await expect(submitCloudflareAbuseReport({ config, session, report, target: context.target, fetch })).rejects.toBeInstanceOf(ProviderSubmissionDuplicateError);
		}
	});

	test("sends one direct dashboard JSON POST with only session auth", async () => {
		let calls = 0;
		const result = await submitCloudflareAbuseReport({ config, session, report, target: context.target, fetch: async (url, init) => {
			calls++;
			expect(url).toBe(cloudflareReportsUrl(ACCOUNT_ID));
			expect(init).toMatchObject({ method: "POST", redirect: "error", headers: {
				"content-type": "application/json", "x-atok": session.atok, cookie: `vses2=${session.vses2}`,
				"x-cross-site-security": "dash", referer: "https://dash.cloudflare.com/", "user-agent": browserUserAgent,
			} });
			expect(init?.headers).not.toHaveProperty("authorization");
			expect(JSON.parse(String(init?.body))).toEqual(buildCloudflareApiBody(report));
			return success();
		} });
		expect(result.confirmationId).toBe("r-1");
		expect(calls).toBe(1);
	});

	test("never retries network failures, server errors, redirects, rejections or missing receipts", async () => {
		for (const response of [new Response("bad gateway", { status: 502 }), new Response("redirect", { status: 302 }), new Response("no", { status: 403 }), new Response('{"result":"success"}'), undefined]) {
			let posts = 0;
			await expect(submitCloudflareAbuseReport({ config, session, report, target: context.target,
				getSession: async () => { throw new Error("must not login"); },
				fetch: async (_url, init) => {
					// An ambiguous answer is looked up read-only; no stored report means it stays ambiguous.
					if (init?.method === "GET") return Response.json({ success: true, result: { reports: [] } });
					posts++;
					if (!response) throw new Error("network");
					return response;
				},
			})).rejects.toThrow();
			expect(posts).toBe(1);
		}
	});

	test("a 504 whose report Cloudflare did store is settled from the account's submitted reports", async () => {
		// Production: report 397af589383e9ad3 was stored while the POST answered HTTP 504.
		const requests: string[] = [];
		const lookup = (justification: string) => async (url: string, init?: RequestInit) => {
			requests.push(`${init?.method} ${url.replace(/^.*\/abuse-reports/, "")}`);
			if (init?.method === "POST") return new Response('{"title":"Error 504: Gateway time-out"}', { status: 504 });
			if (url.includes("/submitted?")) {
				return Response.json({ success: true, result: { reports: [
					{ id: "397af589383e9ad3", cdate: new Date().toISOString(), domain: context.target },
					{ id: "0000000000000001", cdate: "2020-01-01T00:00:00Z", domain: context.target },
				] } });
			}
			return Response.json({ success: true, result: { id: "397af589383e9ad3", urls: [report.urls], justification } });
		};
		const found = await submitCloudflareAbuseReport({ config, session, report, target: context.target, fetch: lookup(report.justification) });
		expect(found).toMatchObject({ confirmationId: "397af589383e9ad3", submittedTargets: [context.target] });
		expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(1);
		// The old report from 2020 is never read; a stored report with other text is not ours.
		expect(requests.some((request) => request.includes("0000000000000001"))).toBeFalse();
		await expect(submitCloudflareAbuseReport({ config, session, report, target: context.target, fetch: lookup("someone else's report") })).rejects.toThrow("HTTP 504");
	});

	test("relogs in exactly once only after an explicit expired-session rejection", async () => {
		let calls = 0;
		let logins = 0;
		await submitCloudflareAbuseReport({ config, session, report, target: context.target,
			getSession: async (received, options) => { logins++; expect(received).toEqual(config); expect(options?.expiredSession).toBe(session); return fresh; },
			fetch: async (_url, init) => { calls++; expect(new Headers(init?.headers).get("x-atok")).toBe(calls === 1 ? session.atok : fresh.atok); return calls === 1 ? expired() : success(); },
		});
		expect(calls).toBe(2);
		expect(logins).toBe(1);
	});

	test("failed reauthentication or a rejected fresh session requires a human without looping", async () => {
		for (const failedLogin of [true, false]) {
			let calls = 0;
			let logins = 0;
			await expect(submitCloudflareAbuseReport({ config, session, report, target: context.target,
				getSession: async () => { logins++; if (failedLogin) throw new Error("secret must not leak"); return fresh; },
				fetch: async () => { calls++; return expired(); },
			})).rejects.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
			expect(calls).toBe(failedLogin ? 1 : 2);
			expect(logins).toBe(1);
		}
	});

	test("fresh-session transport failure remains ambiguous, with no further login", async () => {
		let calls = 0;
		try {
			await submitCloudflareAbuseReport({ config, session, report, target: context.target, getSession: async () => fresh,
				fetch: async (_url, init) => { if (init?.method === "GET") throw new Error("lookup unavailable"); if (++calls === 1) return expired(); throw new Error("connection lost"); },
			});
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
			expect(error).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect((error as Error).message).toBe("connection lost");
		}
		expect(calls).toBe(2);
	});
});

describe("Cloudflare provider preflight", () => {
	/** A stored draft and its route, drafted from a real report. */
	async function ready() {
		const { payload, route } = await readyDraft({ mailbox: "abuse@cloudflare.com", providerName: "Cloudflare" }, (ctx) => cloudflareDraft.prepare(ctx, { environment }), storedCloudflareSubmissionPayload);
		return { payload: payload as unknown as Record<string, unknown>, filed: payload, routeId: route.id };
	}
	test("logs in before the marker and consumes ephemeral session state", async () => {
		const { payload, routeId } = await ready();
		let logins = 0;
		const deps = { environment, getSession: async () => { logins++; return session; }, fetch: async () => success() };
		const preflight = await prepareCloudflareExternalSubmission({ routeId, payload }, deps);
		expect(preflight.state).toBe(session);
		const result = await submitCloudflareSubmission({ routeId, payload }, preflight, deps);
		expect(result.confirmationId).toBe("r-1");
		expect(logins).toBe(1);
		expect(JSON.stringify(payload)).not.toContain(session.atok);
	});
	test("a failed login is retryable before any POST and says when to try again", async () => {
		const { payload, routeId } = await ready();
		// Nothing was sent, so the job retries once the login backoff ends instead of parking the route for a person.
		const unavailable = new ProviderLoginUnavailableError("Cloudflare dashboard login failed: Cloudflare's Turnstile challenge issued no token within 120 s.", 540_000);
		const err = await prepareCloudflareExternalSubmission({ routeId, payload }, { environment, getSession: async () => { throw unavailable; } }).catch((e: unknown) => e);
		expect(err).toBe(unavailable);
		expect(err).not.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(retryDelayMs(err, 0)).toBe(540_000);
	});
	test("refuses malformed stored payloads and missing credentials after the marker", async () => {
		const { payload, routeId } = await ready();
		await expect(submitCloudflareSubmission({ routeId, payload: {} }, { state: session }, { environment })).rejects.toThrow("malformed");
		await expect(submitCloudflareSubmission({ routeId, payload }, { state: session }, { environment: {} })).rejects.toThrow("ABUSE_CLOUDFLARE_ACCOUNT_ID");
	});
	test("a later lookup finds the report a 504 POST stored, read-only and by the exact payload sent", async () => {
		const { payload, filed, routeId } = await ready();
		// Production 2026-11-16: report 58dd5e517c5fc535 (keychainagent.pro) was stored behind an
		// HTTP 504 and listed only after the lookup right after the POST.
		const sentAt = new Date();
		const methods: string[] = [];
		const listing = (justification: string) => async (url: string, init?: RequestInit) => {
			methods.push(init?.method ?? "GET");
			if (url.includes("/submitted?")) return Response.json({ success: true, result: { reports: [{ id: "58dd5e517c5fc535", cdate: sentAt.toISOString(), domain: filed.target }] } });
			return Response.json({ success: true, result: { id: "58dd5e517c5fc535", urls: [filed.report.urls], justification } });
		};
		const deps = { environment, getSession: async () => session };
		expect(await findCloudflareSubmission({ routeId, payload, sentAt }, { ...deps, fetch: listing(filed.report.justification) })).toEqual({
			confirmationId: "58dd5e517c5fc535",
			confirmationText: "Cloudflare stored the abuse report; its answer to the request was lost, and the report was found in the account's submitted reports.",
			finalUrl: `https://dash.cloudflare.com/${ACCOUNT_ID}/abuse-reports/submitted`,
			submittedTargets: [filed.target],
		});
		// Another report on the same domain is not ours.
		expect(await findCloudflareSubmission({ routeId, payload, sentAt }, { ...deps, fetch: listing("another report") })).toBeUndefined();
		expect(methods.every((method) => method === "GET")).toBeTrue();
		// A malformed stored payload is never looked up.
		expect(await findCloudflareSubmission({ routeId, payload: {}, sentAt }, { ...deps, fetch: async () => { throw new Error("must not read"); } })).toBeUndefined();
	});
	test("the lookup reads past the account's 50 newest reports, filters the domain itself, and stops at reports older than the POST", async () => {
		// The listing ignores `search`: every page holds the account's reports of all domains, newest first.
		const { payload, filed, routeId } = await ready();
		const sentAt = new Date("2026-11-26T18:50:53.218Z");
		const at = (minutes: number) => new Date(sentAt.getTime() + minutes * 60_000).toISOString();
		const id = (n: number) => n.toString(16).padStart(16, "0");
		const pages: Record<number, Array<{ id: string; cdate: string; domain: string }>> = {
			// 50 newer reports of other domains fill the first page.
			1: Array.from({ length: 50 }, (_, index) => ({ id: id(1000 + index), cdate: at(60 - index), domain: `other-${index}.example` })),
			// Ours is on the second, with an older report of the same domain from before the POST.
			2: [{ id: "8bb11a971b4aee08", cdate: at(0.3), domain: filed.target }, ...Array.from({ length: 48 }, (_, index) => ({ id: id(2000 + index), cdate: at(-0.1), domain: `more-${index}.example` })), { id: id(3000), cdate: at(-30), domain: filed.target }],
			3: [{ id: id(4000), cdate: at(-60), domain: filed.target }],
		};
		const read: string[] = [];
		const fetch = async (url: string) => {
			read.push(url);
			const page = Number(new URL(url).searchParams.get("page"));
			if (url.includes("/submitted?")) return Response.json({ success: true, result: { reports: pages[page] ?? [] }, result_info: { page, per_page: 50, total_pages: 9 } });
			return Response.json({ success: true, result: { id: url.split("/").at(-1), urls: [filed.report.urls], justification: filed.report.justification } });
		};
		expect(await findCloudflareSubmission({ routeId, payload, sentAt }, { environment, getSession: async () => session, fetch })).toMatchObject({ confirmationId: "8bb11a971b4aee08" });
		const listings = read.filter((url) => url.includes("/submitted?"));
		// Page 2 holds a report older than the POST: page 3 is never read.
		expect(listings.map((url) => new URL(url).searchParams.get("page"))).toEqual(["1", "2"]);
		expect(listings.every((url) => !url.includes("search="))).toBeTrue();
		// Only the domain's report from after the POST is read in detail: the earlier one on the same domain is not ours.
		expect(read.filter((url) => !url.includes("/submitted?"))).toEqual([`https://dash.cloudflare.com/api/v4/accounts/${ACCOUNT_ID}/abuse-reports/submitted/8bb11a971b4aee08`]);
	});
});

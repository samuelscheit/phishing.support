import { describe, expect, test } from "bun:test";

import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { buildCloudflareApiBody, cloudflareApiConfig, cloudflareReportsUrl, CloudflareSessionExpiredError, parseCloudflareApiResponse, submitCloudflareAbuseReport } from "./api";
import type { CloudflareReportPayload } from "./report";
import { prepareCloudflareExternalSubmission, submitCloudflareSubmission } from "./submission";

const ACCOUNT_ID = "b9077acfb4ef45e0f94b0f52c06c289a";
const environment = { ABUSE_CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, ABUSE_CLOUDFLARE_LOGIN_EMAIL: "operator@example.com", ABUSE_CLOUDFLARE_LOGIN_PASSWORD: "test-password" };
const config = { accountId: ACCOUNT_ID, email: "operator@example.com", password: "test-password" };
const session = { atok: "old-atok", vses2: "test-cookie", expiresAt: Date.now() + 86_400_000 };
const fresh = { ...session, atok: "fresh-atok", vses2: "fresh-cookie" };
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

	test("sends one direct dashboard JSON POST with only session auth", async () => {
		let calls = 0;
		const result = await submitCloudflareAbuseReport({ config, session, report, target: context.target, fetch: async (url, init) => {
			calls++;
			expect(url).toBe(cloudflareReportsUrl(ACCOUNT_ID));
			expect(init).toMatchObject({ method: "POST", redirect: "error", headers: {
				"content-type": "application/json", "x-atok": session.atok, cookie: `vses2=${session.vses2}`,
				"x-cross-site-security": "dash", referer: "https://dash.cloudflare.com/",
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
			let calls = 0;
			await expect(submitCloudflareAbuseReport({ config, session, report, target: context.target,
				getSession: async () => { throw new Error("must not login"); },
				fetch: async () => { calls++; if (!response) throw new Error("network"); return response; },
			})).rejects.toThrow();
			expect(calls).toBe(1);
		}
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
				fetch: async () => { if (++calls === 1) return expired(); throw new Error("connection lost"); },
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
	const payload = { adapter: "cloudflare_abuse_api_v1", providerNarrativeVersion: 1, target: context.target, report };
	test("logs in before the marker and consumes ephemeral session state", async () => {
		let logins = 0;
		const deps = { environment, getSession: async () => { logins++; return session; }, fetch: async () => success() };
		const preflight = await prepareCloudflareExternalSubmission({ routeId: 1n, payload }, deps);
		expect(preflight.state).toBe(session);
		const result = await submitCloudflareSubmission({ routeId: 1n, payload }, deps, preflight);
		expect(result.confirmationId).toBe("r-1");
		expect(logins).toBe(1);
		expect(JSON.stringify(payload)).not.toContain(session.atok);
	});
	test("login failure requires a human before any POST", async () => {
		await expect(prepareCloudflareExternalSubmission({ routeId: 1n, payload }, { environment, getSession: async () => { throw new Error("sensitive browser error"); } })).rejects.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
	});
	test("rejects malformed drafts before login or the irreversible-call marker", async () => {
		let logins = 0;
		await expect(prepareCloudflareExternalSubmission({ routeId: 1n, payload: { ...payload, providerNarrativeVersion: 2 } }, {
			environment, getSession: async () => { logins++; return session; },
		})).rejects.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(logins).toBe(0);
	});
	test("refuses malformed stored payloads and missing credentials", async () => {
		await expect(submitCloudflareSubmission({ routeId: 1n, payload: {} }, { environment })).rejects.toThrow("malformed");
		await expect(submitCloudflareSubmission({ routeId: 1n, payload }, { environment: {} })).rejects.toThrow("ABUSE_CLOUDFLARE_ACCOUNT_ID");
	});
});

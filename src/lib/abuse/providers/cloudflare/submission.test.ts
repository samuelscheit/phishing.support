import { describe, expect, test } from "bun:test";

import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { buildCloudflareApiBody, cloudflareApiConfig, cloudflareReportsUrl, parseCloudflareApiResponse, submitCloudflareAbuseReport } from "./api";
import type { CloudflareReportPayload } from "./report";
import { submitCloudflareSubmission } from "./submission";

const ACCOUNT_ID = "b9077acfb4ef45e0f94b0f52c06c289a";
const environment = { ABUSE_CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, ABUSE_CLOUDFLARE_API_TOKEN: "test-token" };

const report: CloudflareReportPayload = {
	name: "Phishing Support",
	email: "support@phishing.support",
	company: "https://phishing.support/",
	urls: "https://phishing.example/collect",
	justification: "The page harvests credentials.",
	originalWork: "https://brand.example/",
	reportedCountry: "DE",
};

const context = { accountId: ACCOUNT_ID, target: "phishing.example" };

describe("Cloudflare API configuration", () => {
	test("requires a 32-character account ID and a token", () => {
		expect(cloudflareApiConfig(environment)).toEqual({ accountId: ACCOUNT_ID, token: "test-token" });
		expect(() => cloudflareApiConfig({ ...environment, ABUSE_CLOUDFLARE_ACCOUNT_ID: "not-an-account" })).toThrow("ABUSE_CLOUDFLARE_ACCOUNT_ID");
		expect(() => cloudflareApiConfig({ ...environment, ABUSE_CLOUDFLARE_API_TOKEN: " " })).toThrow("ABUSE_CLOUDFLARE_API_TOKEN");
		expect(() => cloudflareApiConfig({})).toThrow();
	});

	test("targets the account-scoped phishing endpoint", () => {
		expect(cloudflareReportsUrl(ACCOUNT_ID)).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/abuse-reports/abuse_phishing`);
	});
});

describe("buildCloudflareApiBody", () => {
	test("maps the report onto the documented abuse_phishing schema", () => {
		expect(buildCloudflareApiBody(report)).toEqual({
			act: "abuse_phishing",
			name: "Phishing Support",
			email: "support@phishing.support",
			email2: "support@phishing.support",
			company: "https://phishing.support/",
			urls: "https://phishing.example/collect",
			justification: "The page harvests credentials.",
			original_work: "https://brand.example/",
			reported_country: "DE",
			host_notification: "send-anon",
			owner_notification: "send-anon",
		});
	});

	test("omits original_work when no legitimate brand is known", () => {
		const { originalWork: _unused, ...withoutBrand } = report;
		expect(buildCloudflareApiBody(withoutBrand)).not.toHaveProperty("original_work");
	});
});

describe("parseCloudflareApiResponse", () => {
	test("retains the abuse_rand identifier of an explicit success", () => {
		expect(parseCloudflareApiResponse(200, JSON.stringify({ abuse_rand: "abc123", request: { act: "abuse_phishing" }, result: "success" }), context)).toEqual({
			confirmationId: "abc123",
			confirmationText: "Cloudflare accepted the phishing abuse report.",
			finalUrl: `https://dash.cloudflare.com/${ACCOUNT_ID}/abuse-reports/submitted`,
			submittedTargets: ["phishing.example"],
		});
	});

	test("settles a missing entitlement or token as a known rejection with guidance", () => {
		for (const status of [401, 403, 405]) {
			expect(() => parseCloudflareApiResponse(status, JSON.stringify({ errors: [{ message: "not entitled" }] }), context)).toThrow(ProviderSubmissionRejectedError);
		}
		expect(() => parseCloudflareApiResponse(401, "{}", context)).toThrow("Trust and Safety Write");
		expect(() => parseCloudflareApiResponse(401, JSON.stringify({ errors: [{ message: "not entitled" }] }), context)).toThrow("not entitled");
	});

	test("settles other client errors as rejections carrying Cloudflare's message", () => {
		expect(() => parseCloudflareApiResponse(400, JSON.stringify({ errors: [{ message: "urls: invalid" }] }), context)).toThrow("urls: invalid");
		expect(() => parseCloudflareApiResponse(422, "plain text", context)).toThrow(ProviderSubmissionRejectedError);
	});

	test("keeps server errors and unconfirmed successes ambiguous", () => {
		for (const call of [
			() => parseCloudflareApiResponse(502, "upstream unavailable", context),
			() => parseCloudflareApiResponse(200, "<html>unexpected</html>", context),
			() => parseCloudflareApiResponse(200, JSON.stringify({ result: {} }), context),
			() => parseCloudflareApiResponse(200, JSON.stringify({}), context),
		]) {
			expect(call).toThrow();
			try {
				call();
			} catch (error) {
				expect(error).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			}
		}
	});

	test("rejects an explicit failure body even on HTTP 200", () => {
		expect(() => parseCloudflareApiResponse(200, JSON.stringify({ result: "failure" }), context)).toThrow(ProviderSubmissionRejectedError);
		expect(() => parseCloudflareApiResponse(200, JSON.stringify({ success: false, errors: [{ message: "bad" }] }), context)).toThrow(ProviderSubmissionRejectedError);
	});
});

describe("submitCloudflareAbuseReport", () => {
	test("posts one bearer-authenticated JSON request without following redirects", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const result = await submitCloudflareAbuseReport({
			config: { accountId: ACCOUNT_ID, token: "test-token" },
			report,
			target: "phishing.example",
			fetch: async (url, init) => {
				calls.push({ url, init: init ?? {} });
				return new Response(JSON.stringify({ abuse_rand: "r-1", result: "success" }), { status: 200 });
			},
		});

		expect(result.confirmationId).toBe("r-1");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe(cloudflareReportsUrl(ACCOUNT_ID));
		expect(calls[0]!.init.method).toBe("POST");
		expect(calls[0]!.init.redirect).toBe("error");
		expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer test-token", "content-type": "application/json" });
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual(buildCloudflareApiBody(report));
	});

	test("never retries a failed request", async () => {
		let calls = 0;
		await expect(submitCloudflareAbuseReport({
			config: { accountId: ACCOUNT_ID, token: "test-token" },
			report,
			target: "phishing.example",
			fetch: async () => {
				calls += 1;
				return new Response("bad gateway", { status: 502 });
			},
		})).rejects.toThrow("HTTP 502");
		expect(calls).toBe(1);
	});
});

describe("submitCloudflareSubmission", () => {
	const payload = { adapter: "cloudflare_abuse_api_v1", providerNarrativeVersion: 1, target: "phishing.example", report };

	test("submits the persisted payload with env credentials", async () => {
		const result = await submitCloudflareSubmission({ routeId: 1n, payload }, {
			environment,
			fetch: async () => new Response(JSON.stringify({ abuse_rand: "r-2", result: "success" }), { status: 200 }),
		});
		expect(result).toMatchObject({ confirmationId: "r-2", submittedTargets: ["phishing.example"] });
	});

	test("refuses a payload from the retired browser-form adapter", async () => {
		await expect(submitCloudflareSubmission({ routeId: 1n, payload: { adapter: "cloudflare_abuse_phishing_v1", providerNarrativeVersion: 1, target: "phishing.example", form: {} } }, {
			environment,
			fetch: async () => { throw new Error("must not call Cloudflare"); },
		})).rejects.toThrow("malformed");
	});

	test("refuses to call Cloudflare without credentials", async () => {
		await expect(submitCloudflareSubmission({ routeId: 1n, payload }, {
			environment: {},
			fetch: async () => { throw new Error("must not call Cloudflare"); },
		})).rejects.toThrow("ABUSE_CLOUDFLARE_ACCOUNT_ID");
	});
});

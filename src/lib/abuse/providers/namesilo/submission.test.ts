import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import type { AbuseArtifact } from "../../schema";
import { sha256Hex } from "../../security";
import { providerDefinitionHasValidHash } from "../definition";
import { executeProviderSubmission } from "../submission_execution";
import { ProviderSubmissionRejectedError, type ProviderSubmissionProvider } from "../submission_contracts";
import { NAMESILO_PROVIDER } from "./definition";
import {
	buildNameSiloSubmissionPayload,
	selectNameSiloEvidenceArtifact,
	storedNameSiloSubmissionPayload,
} from "./payload";
import {
	buildNameSiloHttpPayload,
	parseNameSiloSessionResponse,
	parseNameSiloSubmissionResponse,
	prepareNameSiloExternalSubmission,
	prepareNameSiloSubmission,
	submitNameSiloSubmission,
} from "./submission";

useTemporaryDatabase();

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH1EAAAAASUVORK5CYII=", "base64");
const originalCredentials = {
	username: process.env.DEATHBYCAPTCHA_USERNAME,
	password: process.env.DEATHBYCAPTCHA_PASSWORD,
};

beforeEach(() => {
	process.env.DEATHBYCAPTCHA_USERNAME = "test-user";
	process.env.DEATHBYCAPTCHA_PASSWORD = "test-password";
});

afterAll(() => {
	if (originalCredentials.username === undefined) delete process.env.DEATHBYCAPTCHA_USERNAME;
	else process.env.DEATHBYCAPTCHA_USERNAME = originalCredentials.username;
	if (originalCredentials.password === undefined) delete process.env.DEATHBYCAPTCHA_PASSWORD;
	else process.env.DEATHBYCAPTCHA_PASSWORD = originalCredentials.password;
});

function artifact(overrides: Partial<AbuseArtifact> = {}): AbuseArtifact {
	return {
		id: 101n,
		reportId: 99n,
		targetId: null,
		routeId: null,
		runId: null,
		name: "website.png",
		kind: "user_evidence_original",
		mimeType: "image/png",
		sha256: sha256Hex(png),
		size: png.byteLength,
		metadata: {},
		blob: png,
		createdAt: new Date(),
		...overrides,
	};
}

function payload() {
	const evidence = selectNameSiloEvidenceArtifact([artifact()]);
	if (!evidence) throw new Error("Expected valid NameSilo evidence.");
	const value = buildNameSiloSubmissionPayload({
		target: "login.phishing.example.com",
		observedUrl: "https://login.phishing.example.com/collect#fragment",
		description: "The page impersonates Example Bank and collects login credentials.",
		realWebsite: "https://bank.example.org/online",
		evidence,
	});
	if (!value) throw new Error("Expected valid NameSilo payload.");
	return value;
}

function csrfResponse(options: { includeCookies?: boolean; expirationTime?: number } = {}): Response {
	const headers = new Headers({ "content-type": "application/json" });
	if (options.includeCookies !== false) {
		headers.append("set-cookie", "PHPSESSID=session-value; Expires=Sat, 31 Oct 2026 12:00:00 GMT; Path=/; Secure; HttpOnly");
		headers.append("set-cookie", "_csrf-sec2=csrf-cookie; Path=/; Secure; HttpOnly");
	}
	return new Response(JSON.stringify({
		result: "success",
		message: null,
		data: { xsrfToken: "csrf-token", expirationTime: options.expirationTime ?? 2_000 },
	}), { headers });
}

describe("NameSilo phishing report submission", () => {
	test("pins the reviewed definition and exact form mailboxes", () => {
		expect(providerDefinitionHasValidHash(NAMESILO_PROVIDER)).toBeTrue();
		expect(NAMESILO_PROVIDER.exactMailboxes).toEqual(["abuse@namesilo.com", "support@namesilo.com"]);
	});

	test("round-trips a provider-owned draft and builds every multipart form field", async () => {
		const durable = payload();
		expect(storedNameSiloSubmissionPayload(durable)).toEqual(durable);
		expect(durable.target).toEqual({
			normalizedTarget: "login.phishing.example.com",
			registrableDomain: "example.com",
			observedUrl: "https://login.phishing.example.com/collect",
		});
		expect(durable.report.explanation).toContain("NameSilo");
		expect(durable.report.explanation).toContain("bank.example.org");

		const form = buildNameSiloHttpPayload({ payload: durable, evidenceBytes: png, captchaToken: "captcha-token" });
		expect(form.get("email")).toBe("support@phishing.support");
		expect(form.get("realWebsite")).toBe("https://bank.example.org/online");
		expect(form.get("phishingWebsite")).toBe("https://login.phishing.example.com/collect");
		expect(form.get("report")).toBe(durable.report.explanation);
		expect(form.get("g-recaptcha-response")).toBe("captcha-token");
		const file = form.get("file") as File;
		expect(file.name).toMatch(/^namesilo_report_101_[a-f0-9]{12}\.png$/);
		expect(file.type).toBe("image/png");
		expect(Buffer.from(await file.arrayBuffer())).toEqual(png);
	});

	test("rejects a brand URL on the reported target and altered evidence", () => {
		const durable = payload();
		expect(buildNameSiloSubmissionPayload({
			target: durable.target.normalizedTarget,
			observedUrl: durable.target.observedUrl,
			description: durable.report.explanation,
			realWebsite: "https://phishing.example.com/legitimate",
			evidence: durable.evidence,
		})).toBeUndefined();
		const changed = Buffer.from(png);
		changed[0] = 0;
		expect(() => buildNameSiloHttpPayload({ payload: durable, evidenceBytes: changed, captchaToken: "captcha-token" }))
			.toThrow("intact supported evidence image");
	});

	test("requires a fresh CSRF token and both session cookies", async () => {
		await expect(parseNameSiloSessionResponse(csrfResponse(), () => 1_000_000)).resolves.toEqual({
			csrfToken: "csrf-token",
			cookieHeader: "PHPSESSID=session-value; _csrf-sec2=csrf-cookie",
		});
		await expect(parseNameSiloSessionResponse(csrfResponse({ includeCookies: false }), () => 1_000_000))
			.rejects.toThrow("required cookies");
		await expect(parseNameSiloSessionResponse(csrfResponse({ expirationTime: 999 }), () => 1_000_000))
			.rejects.toThrow("malformed or expired");
	});

	test("treats only explicit provider errors as known rejections", async () => {
		await expect(parseNameSiloSubmissionResponse(new Response(JSON.stringify({ result: "success", message: null, data: null }))))
			.resolves.toMatchObject({ result: "success" });
		await expect(parseNameSiloSubmissionResponse(new Response(JSON.stringify({
			result: "error",
			message: "There are already too many reports about this domain",
			code: "400",
		})))).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
		await expect(parseNameSiloSubmissionResponse(new Response(JSON.stringify({ result: "error", message: "Incorrect file" }), { status: 400 })))
			.rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
		await expect(parseNameSiloSubmissionResponse(new Response("not json")))
			.rejects.toThrow("returned malformed JSON");
		await expect(parseNameSiloSubmissionResponse(new Response("upstream unavailable", { status: 502 })))
			.rejects.toThrow("failed with HTTP 502");
	});

	test("executes CSRF and CAPTCHA preflight before one durable multipart POST", async () => {
		const request = await validateAbuseReportRequest({
			targets: ["login.phishing.example.com"],
			allegationCategory: "phishing",
			reporterName: "Test Reporter",
			reporterContactEmail: "reporter@example.org",
			description: "The page impersonates Example Bank and captures login credentials.",
			legalBrandUrl: "https://bank.example.org/online",
			observedUrls: [{ target: "login.phishing.example.com", urls: ["https://login.phishing.example.com/collect"] }],
			evidence: [{ filename: "website.png", mimeType: "image/png", base64: png.toString("base64") }],
		});
		const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
		const [target] = await AbuseRepository.listTargets(created.reportId);
		if (!target) throw new Error("Expected report target.");
		const route = await AbuseRepository.upsertResolvedRoute(target.id, {
			routeKey: "provider_submission:namesilo:contact",
			providerRegistryKey: NAMESILO_PROVIDER.key,
			providerDisplayName: NAMESILO_PROVIDER.displayName,
			routeType: "provider_submission",
			verifiedEmail: "abuse@namesilo.com",
			providerDefinitionVersion: NAMESILO_PROVIDER.version,
			providerDefinitionHash: NAMESILO_PROVIDER.contentHash,
			resolverProvenance: { source: "namesilo_submission_test" },
			resolutionSnapshot: { source: "test" },
			status: "verified",
		});

		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const provider: ProviderSubmissionProvider = {
			definition: NAMESILO_PROVIDER,
			prepareSubmission: (context) => prepareNameSiloSubmission(context, {
				deriveFacts: async () => ({ brandOfficialWebsite: "https://bank.example.org/online" }),
			}),
			prepareExternalSubmission: (context) => prepareNameSiloExternalSubmission(context, {
				fetch: async (input, init) => {
					requests.push({ url: String(input), init });
					return csrfResponse();
				},
				captchaSolver: async () => "captcha-token",
				now: () => 1_000_000,
			}),
			submit: (context) => submitNameSiloSubmission(context),
			submitPrepared: async (context, preflight) => {
				expect(await AbuseRepository.getProviderRun(context.runId!)).toMatchObject({ executionStatus: "submission_started" });
				return submitNameSiloSubmission(context, {
					fetch: async (input, init) => {
						requests.push({ url: String(input), init });
						return new Response(JSON.stringify({ result: "success", message: null, data: null }));
					},
				}, preflight);
			},
		};

		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({
			outcome: "submitted",
			runId: expect.any(BigInt),
		});
		expect(requests.map((entry) => entry.url)).toEqual([
			NAMESILO_PROVIDER.tokenUrl,
			NAMESILO_PROVIDER.submissionUrl,
		]);
		expect(requests[0]?.init?.redirect).toBe("error");
		expect(requests[1]?.init?.redirect).toBe("error");
		const headers = new Headers(requests[1]?.init?.headers);
		expect(headers.get("x-csrf-token")).toBe("csrf-token");
		expect(headers.get("cookie")).toBe("PHPSESSID=session-value; _csrf-sec2=csrf-cookie");
		const form = requests[1]?.init?.body as FormData;
		expect(form.get("g-recaptcha-response")).toBe("captcha-token");
		expect(form.get("phishingWebsite")).toBe("https://login.phishing.example.com/collect");

		const [run] = await AbuseRepository.listProviderRunsForReport(created.reportId);
		expect(run).toMatchObject({
			executionStatus: "completed",
			confirmationText: "NameSilo accepted the phishing report.",
			finalUrl: NAMESILO_PROVIDER.reportPageUrl,
			submittedTargets: ["login.phishing.example.com"],
		});
		expect(JSON.stringify(run?.providerPayload)).not.toContain("csrf-token");
		expect(JSON.stringify(run?.providerPayload)).not.toContain("session-value");
		expect(JSON.stringify(run?.providerPayload)).not.toContain("captcha-token");
	});

	test("settles before preflight when the legitimate brand website cannot be verified", async () => {
		const request = await validateAbuseReportRequest({
			targets: ["phishing.example.com"],
			allegationCategory: "phishing",
			reporterName: "Test Reporter",
			reporterContactEmail: "reporter@example.org",
			description: "The page collects login credentials without naming the impersonated brand.",
			observedUrls: [{ target: "phishing.example.com", urls: ["https://phishing.example.com/"] }],
			evidence: [{ filename: "website.png", mimeType: "image/png", base64: png.toString("base64") }],
		});
		const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
		const [target] = await AbuseRepository.listTargets(created.reportId);
		if (!target) throw new Error("Expected report target.");
		const route = await AbuseRepository.upsertResolvedRoute(target.id, {
			routeKey: "provider_submission:namesilo:contact",
			providerRegistryKey: NAMESILO_PROVIDER.key,
			providerDisplayName: NAMESILO_PROVIDER.displayName,
			routeType: "provider_submission",
			providerDefinitionVersion: NAMESILO_PROVIDER.version,
			providerDefinitionHash: NAMESILO_PROVIDER.contentHash,
			resolverProvenance: {},
			resolutionSnapshot: {},
			status: "verified",
		});
		let preflightCalled = false;
		const provider: ProviderSubmissionProvider = {
			definition: NAMESILO_PROVIDER,
			prepareSubmission: (context) => prepareNameSiloSubmission(context, { deriveFacts: async () => ({}) }),
			prepareExternalSubmission: async () => { preflightCalled = true; return { state: {} }; },
			submit: async () => ({ submittedTargets: [] }),
			submitPrepared: async () => ({ submittedTargets: [] }),
		};
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({
			outcome: "insufficient_evidence",
			reason: "namesilo_requires_a_verified_brand_website",
		});
		expect(preflightCalled).toBeFalse();
		expect(await AbuseRepository.listProviderRunsForReport(created.reportId)).toEqual([]);
	});
});

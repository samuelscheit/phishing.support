import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../../security";
import type { AbuseArtifact } from "../../schema";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { eranetCodeFromMail } from "./code_mail";
import { ERANET_PROVIDER } from "./definition";
import { buildEranetSubmissionPayload, eranetSubTypes, storedEranetSubmissionPayload } from "./payload";
import { prepareEranetExternalSubmission, prepareEranetSubmission, submitEranetSubmission, type EranetDependencies } from "./submission";

// A minimal valid PNG: the evidence contract checks the magic bytes and digest.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const artifact = {
	id: 77n, reportId: 9n, name: "website.png", kind: "user_evidence_original", mimeType: "image/png",
	sha256: sha256Hex(PNG), size: PNG.byteLength, blob: PNG, metadata: {}, createdAt: new Date(),
} as unknown as AbuseArtifact;

function routeContext(allegationCategory: "phishing" | "malware" = "malware") {
	return async () => ({
		route: { id: 5n, routeType: "provider_submission", providerRegistryKey: "eranet", providerDefinitionVersion: ERANET_PROVIDER.version, providerDefinitionHash: ERANET_PROVIDER.contentHash },
		report: { id: 9n, submissionId: 375628583143477248n, allegationCategory, legalBrandUrl: null, description: "The page distributes malware.\nIt downloads and runs code from: hxxps://keychainagent[.]pro/x." },
		target: { normalizedTarget: "keychainagent.pro", targetType: "domain", observedUrls: ["https://keychainagent.pro/wksxgj/x"] },
		evidenceArtifacts: [artifact],
		targets: [],
	}) as never;
}

function eranetApi(responses: Record<string, () => Record<string, unknown>>) {
	const calls: Array<{ path: string; json?: Record<string, unknown>; form?: FormData; headers: Headers }> = [];
	const fetch = async (input: string, init?: RequestInit) => {
		const path = input.replace(`${ERANET_PROVIDER.apiBaseUrl}/`, "");
		const body = init?.body;
		calls.push({ path, headers: new Headers(init?.headers), ...(typeof body === "string" ? { json: JSON.parse(body) } : { form: body as FormData }) });
		const respond = responses[path];
		if (!respond) throw new Error(`unexpected Eranet call ${path}`);
		return Response.json({ RequestId: "r", ...respond() });
	};
	return { calls, fetch };
}

describe("Eranet abuse form", () => {
	test("reads the six-digit code only from Eranet's verification mail", () => {
		const subject = "Online complaint/grievance verification email verification code!";
		expect(eranetCodeFromMail({ from: "system@noreply.eranet.com", subject, body: "<p>Your verification code is: 893731 . Please ignore it</p>" })).toBe("893731");
		expect(eranetCodeFromMail({ from: "attacker@evil.example", subject, body: "Your verification code is: 893731" })).toBeUndefined();
		expect(eranetCodeFromMail({ from: "system@noreply.eranet.com", subject: "Your invoice", body: "Your verification code is: 893731" })).toBeUndefined();
		expect(eranetCodeFromMail({ from: "system@noreply.eranet.com", subject, body: "no code here" })).toBeUndefined();
	});

	test("files a malware report: screenshot upload and mailed code before the marker, one CreateComplaint after it", async () => {
		const prepared = await prepareEranetSubmission({ routeId: 5n, payload: {} }, { loadRouteContext: routeContext() });
		expect(prepared.outcome).toBe("ready");
		const payload = (prepared as { payload: Record<string, unknown> }).payload;
		expect(storedEranetSubmissionPayload(payload)).toMatchObject({
			target: { domain: "keychainagent.pro", observedUrl: "https://keychainagent.pro/wksxgj/x" },
			// Malware impersonates nothing: the required website field carries the case page.
			report: { subTypes: ["other"], website: "https://phishing.support/submissions/375628583143477248" },
		});

		const api = eranetApi({
			UploadFile: () => ({ Data: { filename: "uploads/abc.png" } }),
			GetEmailCode: () => ({}),
			CreateComplaint: () => ({ Data: { OrderNo: "AB20261103001" } }),
		});
		const codeRequests: Date[] = [];
		const deps: EranetDependencies = {
			fetch: api.fetch,
			loadRouteContext: routeContext(),
			getArtifact: async () => artifact,
			readCode: async (requestedAt) => { codeRequests.push(requestedAt); return "893731"; },
			now: () => new Date("2026-11-03T00:00:00Z"),
		};
		const preflight = await prepareEranetExternalSubmission({ routeId: 5n, payload }, deps);
		expect(api.calls.map((call) => call.path)).toEqual(["UploadFile", "GetEmailCode"]);
		expect(api.calls[0]!.form?.get("type")).toBe("reportPageScreenshot");
		expect(api.calls[1]!.json).toEqual({ Email: "support@phishing.support", AliyunCaptchaVerifyParam: "" });
		expect(codeRequests).toEqual([new Date("2026-11-03T00:00:00Z")]);

		const success = await submitEranetSubmission({ routeId: 5n, payload }, preflight, deps);
		expect(api.calls.map((call) => call.path)).toEqual(["UploadFile", "GetEmailCode", "CreateComplaint"]);
		expect(api.calls[2]!.json).toMatchObject({
			Email: "support@phishing.support",
			Code: "893731",
			DomainNames: [{ Domain: "keychainagent.pro", Link: "https://keychainagent.pro/wksxgj/x" }],
			ComplaintType: "phishing",
			SubTypes: "other",
			Screenshot: ["uploads/abc.png"],
			ContactType: "E",
			Website: "https://phishing.support/submissions/375628583143477248",
		});
		expect(String(api.calls[2]!.json?.Description)).toContain("malware distribution domain report is being submitted to Eranet for keychainagent.pro");
		expect(api.calls[2]!.headers.get("referer")).toBe(ERANET_PROVIDER.reportPageUrl);
		expect(success).toEqual({ confirmationId: "AB20261103001", confirmationText: "Eranet accepted the report (receipt AB20261103001).", finalUrl: ERANET_PROVIDER.reportPageUrl, submittedTargets: ["keychainagent.pro"] });
	});

	test("a named Eranet error is a known rejection, and a code that never arrives stops before the marker", async () => {
		const payload = buildEranetSubmissionPayload({ target: "keychainagent.pro", observedUrl: "https://keychainagent.pro/x", description: "The page distributes malware.", allegationCategory: "malware", website: "https://phishing.support/submissions/1" })!;
		const rejecting = eranetApi({ CreateComplaint: () => ({ error: "VerifyCode.NotFound.Code" }) });
		await expect(submitEranetSubmission({ routeId: 5n, payload }, { state: { code: "123456", screenshots: [] } }, { fetch: rejecting.fetch }))
			.rejects.toBeInstanceOf(ProviderSubmissionRejectedError);

		const silent = eranetApi({ GetEmailCode: () => ({}) });
		await expect(prepareEranetExternalSubmission({ routeId: 5n, payload }, {
			fetch: silent.fetch,
			loadRouteContext: routeContext(),
			readCode: async () => { throw new Error("Eranet's verification code did not arrive in time."); },
		})).rejects.toThrow("did not arrive in time");
		expect(silent.calls.map((call) => call.path)).toEqual(["GetEmailCode"]);
	});

	test("phishing reports file as phishing sites, and a stored draft from another definition is refused", () => {
		expect(eranetSubTypes("phishing")).toEqual(["phishing_site"]);
		expect(eranetSubTypes("malware")).toEqual(["other"]);
		const payload = buildEranetSubmissionPayload({ target: "keychainagent.pro", observedUrl: "https://keychainagent.pro/x", description: "x".repeat(40), website: "https://brand.example/" })!;
		expect(storedEranetSubmissionPayload({ ...payload, definition: { version: "old", contentHash: "x" } })).toBeUndefined();
		expect(storedEranetSubmissionPayload({ ...payload, report: { ...payload.report, subTypes: ["porn"] } })).toBeUndefined();
	});
});

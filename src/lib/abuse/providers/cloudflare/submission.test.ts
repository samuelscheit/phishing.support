import { describe, expect, test } from "bun:test";

import { ProviderSubmissionRejectedError } from "../submission_contracts";
import type { CloudflareFormPayload } from "./form";
import { buildCloudflareApiForm, isCloudflareEdgeChallenge, parseCloudflareSubmissionResponse } from "./submission";

const form: CloudflareFormPayload = {
	name: "Phishing Support",
	email: "support@phishing.support",
	emailConfirmation: "support@phishing.support",
	company: "https://phishing.support/",
	urls: "https://phishing.example/collect",
	justification: "The page harvests credentials.",
	originalWork: "https://brand.example/",
	reportedCountry: "DE",
	dsaAttestation: true,
	dsaCertification: true,
};

describe("Cloudflare abuse submission response", () => {
	test("retains an explicit successful confirmation", async () => {
		await expect(parseCloudflareSubmissionResponse({
			ok: () => true,
			status: () => 200,
			text: async () => JSON.stringify({ success: true, case_id: "case-123", message: "Thanks for your report." }),
		}, "https://abuse.cloudflare.com/phishing", "example.com")).resolves.toEqual({
			confirmationId: "case-123",
			confirmationText: "Thanks for your report.",
			finalUrl: "https://abuse.cloudflare.com/phishing",
			submittedTargets: ["example.com"],
		});
	});

	test("treats explicit provider rejections as known outcomes", async () => {
		await expect(parseCloudflareSubmissionResponse({
			ok: () => false,
			status: () => 422,
			text: async () => "invalid form",
		}, "https://abuse.cloudflare.com/phishing", "example.com")).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);

		await expect(parseCloudflareSubmissionResponse({
			ok: () => true,
			status: () => 200,
			text: async () => JSON.stringify({ success: false, errors: [{ message: "invalid report" }] }),
		}, "https://abuse.cloudflare.com/phishing", "example.com")).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
	});

	test("accepts Cloudflare's current result/msg success response", async () => {
		await expect(parseCloudflareSubmissionResponse({
			ok: () => true,
			status: () => 200,
			text: async () => JSON.stringify({ result: "success", msg: "Your report was submitted.", report_ids: ["cf-report-123"] }),
		}, "https://abuse.cloudflare.com/phishing", "example.com")).resolves.toEqual({
			confirmationId: "cf-report-123",
			confirmationText: "Your report was submitted.",
			finalUrl: "https://abuse.cloudflare.com/phishing",
			submittedTargets: ["example.com"],
		});
	});

	test("does not treat an unparseable 2xx body as a confirmed submission", async () => {
		await expect(parseCloudflareSubmissionResponse({
			ok: () => true,
			status: () => 200,
			text: async () => "<html>unexpected response</html>",
		}, "https://abuse.cloudflare.com/phishing", "example.com")).rejects.toThrow("valid JSON confirmation");
	});

	test("fails closed for a parsed response without explicit success or an upstream failure", async () => {
		await expect(parseCloudflareSubmissionResponse({
			ok: () => true,
			status: () => 200,
			text: async () => JSON.stringify({ result: {} }),
		}, "https://abuse.cloudflare.com/phishing", "example.com")).rejects.toThrow("explicit success confirmation");

		await expect(parseCloudflareSubmissionResponse({
			ok: () => false,
			status: () => 502,
			text: async () => "upstream unavailable",
		}, "https://abuse.cloudflare.com/phishing", "example.com")).rejects.toThrow("submission failed with HTTP 502");
	});

	test("rejects a Cloudflare edge challenge instead of leaving the route ambiguous", async () => {
		await expect(parseCloudflareSubmissionResponse({
			ok: () => false,
			status: () => 403,
			headers: () => ({ "cf-mitigated": "challenge", "cf-ray": "ray-test" }),
			text: async () => "<title>Just a moment...</title>",
		}, "https://abuse.cloudflare.com/phishing", "example.com")).rejects.toThrow("no provider confirmation");
		await expect(parseCloudflareSubmissionResponse({
			ok: () => false,
			status: () => 403,
			headers: () => ({ "cf-mitigated": "challenge" }),
			text: async () => "<title>Just a moment...</title>",
		}, "https://abuse.cloudflare.com/phishing", "example.com")).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
	});

	test("recognizes only an explicit managed edge challenge", () => {
		expect(isCloudflareEdgeChallenge({ status: 403, cfMitigated: "challenge", body: "anything" })).toBeTrue();
		expect(isCloudflareEdgeChallenge({ status: 403, cfMitigated: null, body: "<title>Just a moment...</title>" })).toBeTrue();
		expect(isCloudflareEdgeChallenge({ status: 403, cfMitigated: null, body: "<title>Forbidden</title>" })).toBeFalse();
		expect(isCloudflareEdgeChallenge({ status: 200, cfMitigated: "challenge", body: "<title>Just a moment...</title>" })).toBeFalse();
	});

	test("builds the exact form-client API body", () => {
		expect(buildCloudflareApiForm(form, "turnstile-token", "Mozilla/5.0 (X11; Linux x86_64) Chrome/152.0.0.0")).toEqual({
			name: "Phishing Support",
			email: "support@phishing.support",
			email2: "support@phishing.support",
			title: "",
			company: "https://phishing.support/",
			tele: "",
			urls: "https://phishing.example/collect",
			justification: "The page harvests credentials.",
			original_work: "https://brand.example/",
			reported_country: "DE",
			reported_user_agent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/152.0.0.0",
			comments: "",
			host_notification: "send-anon",
			owner_notification: "send-anon",
			dsa_attestation: true,
			act: "abuse_phishing",
			"cf-turnstile-response": "turnstile-token",
		});
	});
});

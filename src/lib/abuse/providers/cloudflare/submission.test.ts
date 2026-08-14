import { describe, expect, test } from "bun:test";

import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { parseCloudflareSubmissionResponse } from "./submission";

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
});

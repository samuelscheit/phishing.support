import { describe, expect, test } from "bun:test";

import { GNAME_PROVIDER } from "./registry";
import {
	AbuseSkyvernAdapter,
	isSafeSkyvernStorageUrl,
	validateSkyvernOutputContract,
	type SkyvernClientPort,
	type SkyvernTaskPayload,
} from "./skyvern";

type RecordedCall = { name: string; args: unknown[] };

function taskPayload(): SkyvernTaskPayload {
	return {
		prompt: "Use the immutable provider payload.",
		url: "https://abuse.provider.example.com/report",
		max_steps: 120,
		data_extraction_schema: { type: "object", additionalProperties: false },
		engine: "skyvern-2.0",
		include_action_history_in_verification: true,
	};
}

function fakeClient(calls: RecordedCall[], options: { uploadUrl?: string } = {}): SkyvernClientPort {
	return {
		runTask: async (...args: unknown[]) => {
			calls.push({ name: "runTask", args });
			return { run_id: "tsk_created", status: "queued" };
		},
		getRun: async (...args: unknown[]) => {
			calls.push({ name: "getRun", args });
			return { data: { run_id: "tsk_created", status: "running" }, rawResponse: { status: 200 } };
		},
		cancelRun: async (...args: unknown[]) => {
			calls.push({ name: "cancelRun", args });
			return {};
		},
		getRunArtifacts: async (...args: unknown[]) => {
			calls.push({ name: "getRunArtifacts", args });
			return [];
		},
		getArtifact: async (...args: unknown[]) => {
			calls.push({ name: "getArtifact", args });
			return {};
		},
		retryRunWebhook: async (...args: unknown[]) => {
			calls.push({ name: "retryRunWebhook", args });
			return {};
		},
		sendTotpCode: async (...args: unknown[]) => {
			calls.push({ name: "sendTotpCode", args });
			return {};
		},
		uploadFile: async (...args: unknown[]) => {
			calls.push({ name: "uploadFile", args });
			return {
				data: { presigned_url: options.uploadUrl ?? "https://storage.example.com/immutable-evidence" },
				rawResponse: { status: 200 },
			};
		},
		runSdkAction: async (...args: unknown[]) => {
			calls.push({ name: "runSdkAction", args });
			return { data: { workflow_run_id: "wr_upload" }, rawResponse: { status: 200 } };
		},
	} as unknown as SkyvernClientPort;
}

function genericProviderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		contract: {
			entryUrl: "https://abuse.provider.example.com/report",
			target: "example.com",
			observedUrls: ["https://login.example.com/collect"],
			allowedFinalDomains: ["provider.example.com"],
		},
		...overrides,
	};
}

function genericOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		form_contract_passed: true,
		confirmation_text: "Your abuse report has been received.",
		confirmation_id: "provider-case-123",
		final_url: "https://abuse.provider.example.com/confirmation",
		submitted_domains: ["example.com"],
		submitted_urls: ["https://login.example.com/collect"],
		provider_errors: [],
		form_drift: false,
		final_submit_clicked: true,
		final_submit_control: "provider_report_submit",
		irreversible_actions: ["provider_report_submit"],
		...overrides,
	};
}

function gnameProviderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		contract: {
			entryUrl: GNAME_PROVIDER.entryUrl,
			providerDefinitionVersion: GNAME_PROVIDER.version,
			providerDefinitionHash: GNAME_PROVIDER.contentHash,
			domains: ["example.com"],
			observedUrls: ["https://login.example.com/collect"],
			allowedFinalDomains: GNAME_PROVIDER.verifiedDomains,
			declarationContract: "gname_service_declaration_v1",
		},
		...overrides,
	};
}

function gnameOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		...genericOutput({ final_url: "https://www.gname.com/abuse/confirmation" }),
		declaration_checked: true,
		declaration_contract: "gname_service_declaration_v1",
		...overrides,
	};
}

describe("Skyvern SDK adapter boundary", () => {
	test("uses SDK-derived request shapes, no retries, and supported Buffer upload metadata", async () => {
		const calls: RecordedCall[] = [];
		const assertedHosts: string[] = [];
		const adapter = new AbuseSkyvernAdapter({
			client: fakeClient(calls),
			assertHost: async (hostname) => {
				assertedHosts.push(hostname);
			},
		});
		const evidence = Buffer.from("immutable evidence bytes");

		await expect(adapter.uploadFile({ buffer: evidence, filename: "evidence.png", mimeType: "image/png" })).resolves.toEqual({
			presignedUrl: "https://storage.example.com/immutable-evidence",
			sha256: "8bfaccd5ccaa419cfb01514df7c0d3fc17ac40b22195e4eed4789ddd53b418ca",
		});
		await expect(adapter.createTask(taskPayload())).resolves.toMatchObject({ runId: "tsk_created" });
		await expect(adapter.getRun("tsk_created")).resolves.toMatchObject({ run_id: "tsk_created", status: "running" });
		await adapter.sendTotpCode({ identifier: "gname-reports@phishing.support", content: "123456", taskId: "tsk_created" });
		await adapter.retryWebhook("tsk_created");
		await adapter.cancelRun("tsk_created");
		await expect(adapter.runSdkUpload({
			url: "https://abuse.provider.example.com/report",
			presignedUrl: "https://storage.example.com/immutable-evidence",
			intention: "Upload the approved evidence file.",
			browserSessionId: "pbs_123",
		})).resolves.toEqual({ workflow_run_id: "wr_upload" });

		const byName = new Map(calls.map((call) => [call.name, call]));
		expect(byName.get("uploadFile")?.args).toEqual([
			{
				file: {
					data: evidence,
					filename: "evidence.png",
					contentType: "image/png",
					contentLength: evidence.byteLength,
				},
			},
			{ maxRetries: 0 },
		]);
		expect(byName.get("runTask")?.args).toEqual([{ body: taskPayload() }, { maxRetries: 0 }]);
		expect(byName.get("sendTotpCode")?.args).toEqual([
			{
				totp_identifier: "gname-reports@phishing.support",
				content: "123456",
				task_id: "tsk_created",
				source: "email",
			},
			{ maxRetries: 0 },
		]);
		expect(byName.get("retryRunWebhook")?.args).toEqual(["tsk_created", undefined, { maxRetries: 0 }]);
		expect(byName.get("cancelRun")?.args).toEqual(["tsk_created", { maxRetries: 0 }]);
		expect(byName.get("runSdkAction")?.args).toEqual([
			{
				url: "https://abuse.provider.example.com/report",
				browser_session_id: "pbs_123",
				action: {
					type: "ai_upload_file",
					file_url: "https://storage.example.com/immutable-evidence",
					intention: "Upload the approved evidence file.",
				},
			},
			{ maxRetries: 0 },
		]);
		expect(assertedHosts).toEqual(["abuse.provider.example.com"]);
	});

	test("rejects local, private, credentialed, and malformed storage URLs before durable task use", async () => {
		for (const value of [
			"https://127.0.0.1/object",
			"https://[::1]/object",
			"https://localhost/object",
			"https://user:pass@storage.example.com/object",
			"https://storage.example.com/object#fragment",
			"http://storage.example.com/object",
			"https://storage.example/object",
		]) {
			expect(isSafeSkyvernStorageUrl(value), value).toBeFalse();
		}
		expect(isSafeSkyvernStorageUrl("https://storage.example.com/object?X-Amz-Signature=opaque")).toBeTrue();

		const originalOrigin = process.env.SKYVERN_INTERNAL_S3_ORIGIN;
		try {
			process.env.SKYVERN_INTERNAL_S3_ORIGIN = "http://skyvern-minio:9000";
			expect(isSafeSkyvernStorageUrl("http://skyvern-minio:9000/skyvern-uploads/evidence.png")).toBeTrue();
		} finally {
			if (originalOrigin === undefined) delete process.env.SKYVERN_INTERNAL_S3_ORIGIN;
			else process.env.SKYVERN_INTERNAL_S3_ORIGIN = originalOrigin;
		}

		const calls: RecordedCall[] = [];
		const adapter = new AbuseSkyvernAdapter({
			client: fakeClient(calls, { uploadUrl: "https://127.0.0.1/evidence" }),
			assertHost: async () => {
				throw new Error("Unsafe SDK target must not reach DNS validation.");
			},
		});
		await expect(adapter.uploadFile({ buffer: Buffer.from("evidence"), filename: "evidence.png", mimeType: "image/png" })).rejects.toThrow("unsafe presigned upload URL");
		await expect(adapter.runSdkUpload({
			url: "https://127.0.0.1/provider-form",
			presignedUrl: "https://storage.example.com/evidence",
			intention: "Upload approved evidence.",
		})).rejects.toThrow("valid public HTTPS URL");
		await expect(adapter.runSdkUpload({
			url: "https://abuse.provider.example.com/provider-form",
			presignedUrl: "https://localhost/evidence",
			intention: "Upload approved evidence.",
		})).rejects.toThrow("unsafe presigned upload URL");
		expect(calls.filter((call) => call.name === "runSdkAction")).toHaveLength(0);
	});
});

describe("Skyvern output contracts", () => {
	test("accepts complete, pinned generic and GNAME submission contracts", () => {
		expect(validateSkyvernOutputContract({
			output: genericOutput(),
			providerKey: "generic_verified_provider_form",
			providerPayload: genericProviderPayload(),
		})).toMatchObject({
			passed: true,
			confirmationId: "provider-case-123",
			finalUrl: "https://abuse.provider.example.com/confirmation",
			submittedTargets: ["example.com"],
		});
		expect(validateSkyvernOutputContract({
			output: gnameOutput(),
			providerKey: "gname",
			providerPayload: gnameProviderPayload(),
		})).toMatchObject({
			passed: true,
			finalUrl: "https://www.gname.com/abuse/confirmation",
		});
	});

	test("fails closed for generic provider output drift and provider-declared errors", () => {
		const validate = (output: Record<string, unknown>, providerPayload = genericProviderPayload()) =>
			validateSkyvernOutputContract({ output, providerKey: "generic_verified_provider_form", providerPayload });

		expect(validate(genericOutput({ attacker_selected_url: "https://evil.example.com" }))).toMatchObject({ passed: false, reason: "unexpected_extraction_output" });
		expect(validate(genericOutput({ final_url: "https://evil.example.com/confirmation" }))).toMatchObject({ passed: false, reason: "final_url_origin_drift" });
		expect(validate(genericOutput({ final_submit_clicked: false }))).toMatchObject({ passed: false, reason: "final_submit_contract_missing" });
		expect(validate(genericOutput({ final_submit_control: "create_account" }))).toMatchObject({ passed: false, reason: "final_submit_contract_missing" });
		expect(validate(genericOutput({ irreversible_actions: ["provider_report_submit", "purchase"] }))).toMatchObject({ passed: false, reason: "unexpected_irreversible_action" });
		expect(validate(genericOutput({ provider_errors: "request failed" }))).toMatchObject({ passed: false, reason: "provider_error_output_invalid" });
		expect(validate(genericOutput({ provider_errors: ["The provider rejected this submission."] }))).toMatchObject({ passed: false, reason: "provider_reported_error" });
		expect(validate(genericOutput({ confirmation_text: "" }))).toMatchObject({ passed: false, reason: "confirmation_text_missing" });
		expect(validate(genericOutput({ submitted_domains: ["other.example.com"] }))).toMatchObject({ passed: false, reason: "submitted_target_contract_mismatch" });
		expect(validate(genericOutput({ submitted_urls: ["https://login.example.com/other"] }))).toMatchObject({ passed: false, reason: "submitted_target_contract_mismatch" });
		expect(validate(genericOutput(), genericProviderPayload({
			contract: {
				entryUrl: "https://evil.example.com/report",
				target: "example.com",
				observedUrls: ["https://login.example.com/collect"],
				allowedFinalDomains: ["provider.example.com"],
			},
		}))).toMatchObject({ passed: false, reason: "immutable_entry_url_invalid" });
		expect(validate(genericOutput({ form_drift: true, form_drift_reason: "The mandatory complaint field was renamed." }))).toMatchObject({
			passed: false,
			reason: "The mandatory complaint field was renamed.",
		});
	});

	test("fails closed for GNAME declaration and registry-pin drift", () => {
		const validate = (output: Record<string, unknown>, providerPayload = gnameProviderPayload()) =>
			validateSkyvernOutputContract({ output, providerKey: "gname", providerPayload });

		expect(validate(gnameOutput({ declaration_checked: false }))).toMatchObject({ passed: false, reason: "gname_declaration_contract_mismatch" });
		expect(validate(gnameOutput({ declaration_contract: "gname_service_declaration_v2" }))).toMatchObject({ passed: false, reason: "gname_declaration_contract_mismatch" });
		expect(validate(gnameOutput({ declaration_checked: undefined }))).toMatchObject({ passed: false, reason: "gname_declaration_contract_mismatch" });
		expect(validate(gnameOutput(), gnameProviderPayload({
			contract: {
				...gnameProviderPayload().contract as Record<string, unknown>,
				providerDefinitionVersion: "unreviewed-version",
			},
		}))).toMatchObject({ passed: false, reason: "provider_definition_pin_mismatch" });
		expect(validate(gnameOutput({ form_drift: true, form_drift_reason: "The declaration wording changed materially." }))).toMatchObject({
			passed: false,
			reason: "The declaration wording changed materially.",
		});
	});
});

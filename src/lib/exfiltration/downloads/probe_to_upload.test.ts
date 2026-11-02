import { describe, expect, test } from "bun:test";

import type { FabricEgress } from "../../browser/fabric";
import { runExfiltrationProbe } from "../probe";
import type { ExfiltrationCanaries } from "../types";
import { investigateCollectedDownload, type DownloadPipelineConfig } from "./pipeline";

const canaries: ExfiltrationCanaries = { marker: "psprobe_e2e0000000000000", email: "probe.e2e@probe-canary.invalid", password: "A9!psprobe_e2e!qZ", phone: "+12125550102", cardNumber: "4242424242424242", oneTimeCode: "123456" };
const downloadUrl = "https://storage.example.net/run/installer.zip";
const payload = Buffer.from("PK\u0003\u0004synthetic-zip-payload-for-the-probe-to-upload-test");

describe("probe to upload, end to end with fakes only", () => {
	test("a probe download reaches the upload transport only after the lookups report unknown, and carries the safe leaf name", async () => {
		const uploads: Array<{ provider: string; fileName: string; bytes: number }> = [];
		const lookedUp: string[] = [];
		const config: DownloadPipelineConfig = {
			storeRoot: undefined,
			malwareBazaarAuthKey: undefined,
			virusTotalApiKey: "vt-test-key",
			uploadPermitted: new Set(["virustotal" as const]),
			retentionMs: 30 * 86_400_000,
		};
		const adapter = {
			createTask: async () => ({ runId: "run-phishing", response: {} }),
			getRun: async () => ({ status: "completed", downloaded_files: [{ url: downloadUrl, filename: "../../Teams.zip", checksum: "f".repeat(64) }] }),
			cancelRun: async () => undefined,
		};
		const result = await runExfiltrationProbe(
			{ reportId: 1n, submissionId: 2n, pageUrl: "https://phish.example/", reporter: {} },
			adapter,
			undefined,
			{
				createCanaries: () => canaries,
				acquireBinding: async (egress: FabricEgress) => ({ sessionId: `browser-session_${egress}`, browserAddress: `ws://relay/${egress}`, release: async () => undefined, cancel: async () => undefined }),
				connectBrowser: async () => ({ disconnect: () => undefined } as never),
				createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
				enrich: async (backend: unknown) => backend as never,
				report: async () => undefined,
				saveCapture: async () => undefined,
				heartbeat: async () => undefined,
				sleep: async () => undefined,
				investigateDownload: (file) => investigateCollectedDownload(file, config, {
					fetch: async (url) => { expect(url).toBe(downloadUrl); return { body: payload }; },
					lookups: async (sha256) => { lookedUp.push(sha256); return [{ provider: "virustotal", state: "not_found" }]; },
					submit: async (provider, file) => { uploads.push({ provider, fileName: file.fileName, bytes: file.bytes.byteLength }); return { state: "submitted", analysisId: "analysis-e2e" }; },
				}),
			},
		);
		expect(result).toMatchObject({ egress: "phishing" });
		expect(lookedUp).toHaveLength(1);
		expect(uploads).toEqual([{ provider: "virustotal", fileName: expect.stringMatching(/^[a-f0-9]{16}\.bin$/), bytes: payload.byteLength }]);
	});

	test("a probe download whose lookup failed is never uploaded, even when the provider is permitted", async () => {
		let uploads = 0;
		const config: DownloadPipelineConfig = { storeRoot: undefined, malwareBazaarAuthKey: undefined, virusTotalApiKey: "k", uploadPermitted: new Set(["virustotal" as const]), retentionMs: 30 * 86_400_000 };
		await investigateCollectedDownload({ url: new URL(downloadUrl), remoteName: "a.zip", reportedSha256: undefined }, config, {
			fetch: async () => ({ body: payload }),
			lookups: async () => [{ provider: "virustotal", state: "unavailable", reason: "HTTP 429" }],
			submit: async () => { uploads++; return { state: "submitted", analysisId: "x" }; },
		});
		expect(uploads).toBe(0);
	});
});

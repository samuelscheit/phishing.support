import { describe, expect, test } from "bun:test";

import type { FabricEgress } from "../../browser/fabric";
import { runExfiltrationProbe } from "../probe";
import type { ExfiltrationCanaries } from "../types";

const canaries: ExfiltrationCanaries = { marker: "psprobe_step0000000000", email: "probe.step@probe-canary.invalid", password: "A9!psprobe_step!qZ", phone: "+12125550101", cardNumber: "4242424242424242", oneTimeCode: "123456" };
const input = { reportId: 1n, submissionId: 2n, pageUrl: "https://phish.example/", phishingBasis: "credential_theft" as const, reporter: {} };

function harness(downloadedFiles: unknown, options: { fetchFails?: boolean } = {}) {
	const saved: string[] = [];
	const investigated: string[] = [];
	const adapter = {
		createTask: async () => ({ runId: "run-phishing", response: {} }),
		getRun: async () => ({ status: "completed", downloaded_files: downloadedFiles }),
		cancelRun: async () => undefined,
	};
	return {
		saved,
		investigated,
		run: () => runExfiltrationProbe(input, adapter, undefined, {
			createCanaries: () => canaries,
			acquireBinding: async (egress: FabricEgress) => ({ sessionId: `browser-session_${egress}`, browserAddress: `ws://relay/${egress}`, release: async () => undefined, cancel: async () => undefined }),
			connectBrowser: async () => ({ disconnect: () => undefined } as never),
			createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
			enrich: async (backend: unknown) => backend as never,
			report: async () => undefined,
			saveCapture: async () => { saved.push("capture"); },
			heartbeat: async () => undefined,
			sleep: async () => undefined,
			investigateDownload: async (file) => {
				if (options.fetchFails) throw new Error("download host refused");
				investigated.push(file.url.toString());
				return undefined;
			},
		}),
	};
}

describe("download step inside the probe", () => {
	test("saves the network capture before any download is investigated", async () => {
		const order: string[] = [];
		const h = harness([{ url: "https://storage.example.net/x.zip", filename: "x.zip" }]);
		const runWithOrder = () => runExfiltrationProbe(input, {
			createTask: async () => ({ runId: "run-phishing", response: {} }),
			getRun: async () => ({ status: "completed", downloaded_files: [{ url: "https://storage.example.net/x.zip", filename: "x.zip" }] }),
			cancelRun: async () => undefined,
		}, undefined, {
			createCanaries: () => canaries,
			acquireBinding: async (egress: FabricEgress) => ({ sessionId: `browser-session_${egress}`, browserAddress: `ws://relay/${egress}`, release: async () => undefined, cancel: async () => undefined }),
			connectBrowser: async () => ({ disconnect: () => undefined } as never),
			createRecorder: () => ({ start: async () => undefined, stop: async () => [] }),
			enrich: async (backend: unknown) => backend as never,
			report: async () => undefined,
			saveCapture: async () => { order.push("capture"); },
			heartbeat: async () => undefined,
			sleep: async () => undefined,
			investigateDownload: async () => { order.push("download"); return undefined; },
		});
		await runWithOrder();
		expect(order).toEqual(["capture", "download"]);
		expect(h.saved).toEqual([]);
	});

	test("a download that cannot be fetched never fails the probe or loses the capture", async () => {
		const h = harness([{ url: "https://storage.example.net/x.zip", filename: "x.zip" }], { fetchFails: true });
		const result = await h.run();
		expect(result).toMatchObject({ egress: "phishing" });
		// The capture is saved by the probe's own persistence call, not by the download step.
		expect(h.saved).toEqual(["capture"]);
	});

	test("an unsafe download URL is never investigated", async () => {
		const h = harness([{ url: "https://127.0.0.1/x.zip", filename: "x.zip" }]);
		await h.run();
		expect(h.investigated).toEqual([]);
		expect(h.saved).toEqual(["capture"]);
	});
});

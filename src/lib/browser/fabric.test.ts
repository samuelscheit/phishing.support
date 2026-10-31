import { describe, expect, test } from "bun:test";

import {
	buildFabricBrowserSessionCreatePayload,
	connectThroughRelay,
	disconnectFabricPatchrightClient,
	fabricBrowserConfigFromEnvironment,
	fabricRelayEndpoint,
} from "./fabric";

function environment(overrides: Record<string, string | undefined> = {}) {
	return {
		FABRIC_API_URL: "http://fabric-cdp-relay:8085/v1",
		FABRIC_PROJECT: "project_phishing",
		FABRIC_PHISHING_PROFILE_REF: "profile_phishing",
		FABRIC_PHISHING_RECIPE_REF: "recipe_rebrowser-phishing@1",
		FABRIC_PHISHING_ARTIFACT_POLICY_REF: "artifact-policy_standard-30-days@1",
		FABRIC_PHISHING_TTL_SECONDS: "900",
		...overrides,
	};
}

describe("Phishing Support Browser Fabric boundary", () => {
	test("requires the complete private Fabric relay contract and never offers a local-browser fallback", () => {
		expect(fabricBrowserConfigFromEnvironment({ environment: {} })).toBeUndefined();
		expect(() => fabricBrowserConfigFromEnvironment({
			environment: environment({ FABRIC_PHISHING_PROFILE_REF: undefined }),
		})).toThrow("FABRIC_PHISHING_PROFILE_REF");
	});

	test("splits egress: phishing defaults to Tor, reporting to direct, residential to the Mac exit, all overridable", () => {
		const config = fabricBrowserConfigFromEnvironment({ environment: environment() });
		if (!config) throw new Error("test Fabric configuration is missing");
		const create = (egress?: "phishing" | "reporting" | "residential") =>
			buildFabricBrowserSessionCreatePayload(config, {}, "writer", "phishing-test-idempotency-key", egress);
		expect(create().egressPolicyRef).toBe("egress_tor-egress@1");
		expect(create("phishing").egressPolicyRef).toBe("egress_tor-egress@1");
		expect(create("reporting").egressPolicyRef).toBe("egress_direct-egress@1");
		expect(create("residential").egressPolicyRef).toBe("egress_mac-exit@1");

		const custom = fabricBrowserConfigFromEnvironment({
			environment: environment({
				FABRIC_PHISHING_EGRESS_POLICY_REF: "egress_custom-tor@2",
				FABRIC_REPORTING_EGRESS_POLICY_REF: "egress_custom-direct@2",
				FABRIC_RESIDENTIAL_EGRESS_POLICY_REF: "egress_custom-exit@2",
			}),
		});
		expect(custom?.egressPolicyRefs).toEqual({ phishing: "egress_custom-tor@2", reporting: "egress_custom-direct@2", residential: "egress_custom-exit@2" });
		expect(() => fabricBrowserConfigFromEnvironment({
			environment: environment({ FABRIC_REPORTING_EGRESS_POLICY_REF: "direct" }),
		})).toThrow("FABRIC_REPORTING_EGRESS_POLICY_REF");
	});

	test("creates a scalar-only Fabric session payload without credentials, cookies, or proxy data", () => {
		const config = fabricBrowserConfigFromEnvironment({ environment: environment() });
		if (!config) throw new Error("test Fabric configuration is missing");
		const payload = buildFabricBrowserSessionCreatePayload(
			config,
			{ operation: "gname-evidence-capture", reportId: "42", retry: false },
			"clone",
			"phishing-test-idempotency-key",
		);

		expect(payload).toEqual(expect.objectContaining({
			project: "project_phishing",
			browserRecipeRef: "recipe_rebrowser-phishing@1",
			profileRef: "profile_phishing",
			leaseMode: "clone",
			metadata: {
				operation: "gname-evidence-capture",
				reportId: "42",
				retry: false,
				workload: "phishing-support",
			},
		}));
		expect(JSON.stringify(payload)).not.toMatch(/cookie|credential|password|proxy|token/i);
		expect(payload.maxExternalConnections).toBe(1);
		expect(buildFabricBrowserSessionCreatePayload(
			config,
			{ operation: "exfiltration-probe" },
			"clone",
			"probe-idempotency-key",
			"phishing",
			2,
		).maxExternalConnections).toBe(2);
		expect(() => buildFabricBrowserSessionCreatePayload(
			config,
			{ proxyUrl: "http://user:password@proxy.example" },
			"clone",
			"phishing-test-idempotency-key",
		)).toThrow("ephemeral Fabric input request");
	});

	test("uses only an opaque private relay route and never forwards a Fabric capability", () => {
		const endpoint = fabricRelayEndpoint("browser-session_phishing-test", "http://fabric-cdp-relay:8085");
		expect(endpoint).toBe("ws://fabric-cdp-relay:8085/v1/cdp/browser-session_phishing-test");
		expect(new URL(endpoint).search).toBe("");
		for (const relay of [
			"http://fabric-cdp-relay:8085?cap=attacker",
			"https://user:pass@fabric-cdp-relay:8085",
			"http://fabric-cdp-relay:8085/v1/cdp",
		]) {
			expect(() => fabricRelayEndpoint("browser-session_phishing-test", relay)).toThrow("FABRIC_CDP_RELAY_URL");
		}
		expect(() => fabricRelayEndpoint("browser-session_phishing-test?cap=attacker", "http://fabric-cdp-relay:8085")).toThrow("session ID");
	});

	test("disconnects Patchright's client transport without issuing Browser.close to Fabric Chromium", async () => {
		let remoteBrowserClose = 0;
		let clientTransportClose = 0;
		const browser = {
			close: async () => { remoteBrowserClose += 1; },
			_connection: {
				close: () => { clientTransportClose += 1; },
			},
		};

		await disconnectFabricPatchrightClient(browser);
		expect(clientTransportClose).toBe(1);
		expect(remoteBrowserClose).toBe(0);
	});

	describe("relay capacity", () => {
		const relayFull = () => new Error("WebSocket connection to 'ws://fabric-cdp-relay-phishing:8085/v1/cdp/browser-session_abc' failed: Expected 101 status code");

		test("waits while every relay connection is taken, keeping the session alive, then connects", async () => {
			let attempts = 0;
			let heartbeats = 0;
			let clock = 0;
			const realNow = Date.now;
			Date.now = () => clock;
			try {
				const browser = await connectThroughRelay(
					async () => {
						attempts++;
						if (attempts < 8) throw relayFull();
						return "browser";
					},
					async () => { heartbeats++; },
					{ retryMs: 2_000, sleep: async (ms) => { clock += ms; } },
				);
				expect(browser).toBe("browser");
				expect(attempts).toBe(8);
				// 14 seconds of waiting crosses one 10-second heartbeat interval.
				expect(heartbeats).toBe(1);
			} finally {
				Date.now = realNow;
			}
		});

		test("gives up once the relay stays full past the bound", async () => {
			let clock = 0;
			const realNow = Date.now;
			Date.now = () => clock;
			try {
				await expect(connectThroughRelay(
					async () => { throw relayFull(); },
					async () => undefined,
					{ waitMs: 10_000, retryMs: 2_000, sleep: async (ms) => { clock += ms; } },
				)).rejects.toThrow("Expected 101 status code");
				expect(clock).toBe(10_000);
			} finally {
				Date.now = realNow;
			}
		});

		test("recognizes a full relay reported as a WebSocket ErrorEvent, as puppeteer does under Bun", async () => {
			let attempts = 0;
			// puppeteer's browser transport rejects with the raw event; its cause is in `error`/`message`.
			const errorEvent = () => Object.assign(new Event("error"), { message: "Unexpected server response: 503", error: new Error("Unexpected server response: 503") });
			const browser = await connectThroughRelay(
				async () => {
					attempts++;
					if (attempts < 3) throw errorEvent();
					return "browser";
				},
				async () => undefined,
				{ sleep: async () => undefined },
			);
			expect(browser).toBe("browser");
			expect(attempts).toBe(3);
			// A different failure surfaces as a readable Error, never as "[object ErrorEvent]".
			const refused = await connectThroughRelay(
				async () => { throw Object.assign(new Event("error"), { message: "connect ECONNREFUSED 10.0.0.1:8085" }); },
				async () => undefined,
				{ sleep: async () => undefined },
			).then(() => undefined, (error: unknown) => error);
			expect(refused).toBeInstanceOf(Error);
			expect((refused as Error).message).toBe("connect ECONNREFUSED 10.0.0.1:8085");
		});

		test("never retries a failure that is not the relay being full", async () => {
			let attempts = 0;
			await expect(connectThroughRelay(
				async () => { attempts++; throw new Error("Browser Fabric session ended in failed"); },
				async () => undefined,
				{ sleep: async () => undefined },
			)).rejects.toThrow("session ended in failed");
			expect(attempts).toBe(1);
		});
	});
});

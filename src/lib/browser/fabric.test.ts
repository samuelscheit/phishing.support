import { describe, expect, test } from "bun:test";

import {
	buildFabricBrowserSessionCreatePayload,
	connectFabricPuppeteerBrowser,
	disconnectFabricPatchrightClient,
	fabricBrowserConfigFromEnvironment,
	fabricRelayEndpoint,
	isTransientFabricBrowserConnectError,
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

	test("splits egress: phishing defaults to Tor, reporting to direct, both overridable", () => {
		const config = fabricBrowserConfigFromEnvironment({ environment: environment() });
		if (!config) throw new Error("test Fabric configuration is missing");
		const create = (egress?: "phishing" | "reporting") =>
			buildFabricBrowserSessionCreatePayload(config, {}, "writer", "phishing-test-idempotency-key", egress);
		expect(create().egressPolicyRef).toBe("egress_tor-egress@1");
		expect(create("phishing").egressPolicyRef).toBe("egress_tor-egress@1");
		expect(create("reporting").egressPolicyRef).toBe("egress_direct-egress@1");

		const custom = fabricBrowserConfigFromEnvironment({
			environment: environment({
				FABRIC_PHISHING_EGRESS_POLICY_REF: "egress_custom-tor@2",
				FABRIC_REPORTING_EGRESS_POLICY_REF: "egress_custom-direct@2",
			}),
		});
		expect(custom?.egressPolicyRefs).toEqual({ phishing: "egress_custom-tor@2", reporting: "egress_custom-direct@2" });
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

	test("retries a relay handshake that closes while Fabric is allocating Chromium and enables invalid certificates", async () => {
		const attempts: Array<{ browserWSEndpoint: string; acceptInsecureCerts: boolean }> = [];
		const delays: number[] = [];
		const browser = {} as any;
		let calls = 0;
		const result = await connectFabricPuppeteerBrowser(
			async (options) => {
				attempts.push(options);
				calls += 1;
				if (calls < 3) throw new Error("Protocol error (Target.getBrowserContexts): Target closed");
				return browser;
			},
			"ws://fabric-cdp-relay:8085/v1/cdp/browser-session_test",
			{ sleep: async (milliseconds) => { delays.push(milliseconds); } },
		);

		expect(result).toBe(browser);
		expect(attempts).toEqual([
			{ browserWSEndpoint: "ws://fabric-cdp-relay:8085/v1/cdp/browser-session_test", acceptInsecureCerts: true },
			{ browserWSEndpoint: "ws://fabric-cdp-relay:8085/v1/cdp/browser-session_test", acceptInsecureCerts: true },
			{ browserWSEndpoint: "ws://fabric-cdp-relay:8085/v1/cdp/browser-session_test", acceptInsecureCerts: true },
		]);
		expect(delays).toEqual([250, 500]);
	});

	test("does not retry non-startup protocol failures", async () => {
		let calls = 0;
		await expect(connectFabricPuppeteerBrowser(
			async () => {
				calls += 1;
				throw new Error("Protocol error (Target.createTarget): Not supported");
			},
			"ws://fabric-cdp-relay:8085/v1/cdp/browser-session_test",
			{ sleep: async () => undefined },
		)).rejects.toThrow("Target.createTarget");
		expect(calls).toBe(1);
		expect(isTransientFabricBrowserConnectError(new Error("Protocol error (Target.getBrowserContexts): Target closed"))).toBeTrue();
		expect(isTransientFabricBrowserConnectError(new Error("Protocol error (Target.createTarget): Not supported"))).toBeFalse();
	});
});

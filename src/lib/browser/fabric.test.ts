import { describe, expect, test } from "bun:test";

import {
	buildFabricBrowserSessionCreatePayload,
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
		FABRIC_PHISHING_EGRESS_POLICY_REF: "egress_phishing-residential@1",
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
});

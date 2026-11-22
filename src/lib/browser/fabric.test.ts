import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { chromiumAvailable, launchTestChromium } from "./task/test_helpers";
import {
	acquireFabricCdpSession,
	acquireFabricPatchrightSession,
	BrowserUnavailableError,
	buildFabricBrowserSessionCreatePayload,
	connectThroughRelay,
	fabricBrowserConfigFromEnvironment,
	isBrowserUnavailable,
	fabricRelayEndpoint,
	type FabricBrowserConfig,
} from "./fabric";

function environment(overrides: Record<string, string | undefined> = {}) {
	return {
		FABRIC_API_URL: "http://fabric-cdp-relay:8085/v1",
		FABRIC_PROJECT: "project_phishing",
		...overrides,
	};
}

describe("Phishing Support Browser Fabric boundary", () => {
	test("requires only the relay and project, and never offers a local-browser fallback", () => {
		expect(fabricBrowserConfigFromEnvironment({ environment: {} })).toBeUndefined();
		expect(() => fabricBrowserConfigFromEnvironment({
			environment: environment({ FABRIC_PROJECT: undefined }),
		})).toThrow("FABRIC_PROJECT is required");
	});

	test("defaults every reference to a Fabric built-in: one chrome runtime, the headful recipe, the default profile", () => {
		expect(fabricBrowserConfigFromEnvironment({ environment: environment() })).toEqual({
			baseUrl: "http://fabric-cdp-relay:8085/v1",
			project: "project_phishing",
			runtime: "chrome",
			profileRef: "profile_default",
			recipeRef: "recipe_chrome@1",
			egressPolicyRefs: { phishing: "egress_tor@1", reporting: "egress_direct@1", residential: "egress_residential@1" },
			artifactPolicyRef: "artifact-policy_standard-30-days@1",
			ttlSeconds: 900,
		});
		const custom = fabricBrowserConfigFromEnvironment({
			environment: environment({
				FABRIC_BROWSER_RUNTIME: "chrome",
				FABRIC_PROFILE_REF: "profile_reporting",
				FABRIC_RECIPE_REF: "recipe_chrome-headless@1",
				FABRIC_ARTIFACT_POLICY_REF: "artifact-policy_short@2",
				FABRIC_TTL_SECONDS: "3600",
			}),
		});
		expect(custom).toMatchObject({ profileRef: "profile_reporting", recipeRef: "recipe_chrome-headless@1", artifactPolicyRef: "artifact-policy_short@2", ttlSeconds: 3600 });
	});

	test("validates every reference: the right kind, a catalog name, and an explicit version", () => {
		const invalid: Array<[string, string]> = [
			["FABRIC_RECIPE_REF", "recipe_rebrowser phishing@1"],
			["FABRIC_RECIPE_REF", "recipe_chrome"],
			["FABRIC_RECIPE_REF", "egress_tor@1"],
			["FABRIC_RECIPE_REF", "recipe_Chrome@1"],
			["FABRIC_RECIPE_REF", "recipe_chrome@0"],
			["FABRIC_PHISHING_EGRESS_POLICY_REF", "tor"],
			["FABRIC_REPORTING_EGRESS_POLICY_REF", "egress_direct"],
			["FABRIC_RESIDENTIAL_EGRESS_POLICY_REF", "recipe_chrome@1"],
			["FABRIC_ARTIFACT_POLICY_REF", "artifact-policy_standard-30-days"],
			["FABRIC_PROFILE_REF", "default"],
			["FABRIC_PROJECT", "phishing"],
			["FABRIC_BROWSER_RUNTIME", "rebrowser puppeteer"],
			["FABRIC_TTL_SECONDS", "59"],
			["FABRIC_TTL_SECONDS", "14401"],
			["FABRIC_TTL_SECONDS", "900s"],
		];
		for (const [name, value] of invalid) {
			expect(() => fabricBrowserConfigFromEnvironment({ environment: environment({ [name]: value }) }), `${name}=${value}`).toThrow(name);
		}
	});

	test("splits egress: phishing defaults to Tor, reporting to direct, residential to the catalog's residential exit, all overridable", () => {
		const config = fabricBrowserConfigFromEnvironment({ environment: environment() });
		if (!config) throw new Error("test Fabric configuration is missing");
		const create = (egress?: "phishing" | "reporting" | "residential") =>
			buildFabricBrowserSessionCreatePayload(config, {}, "writer", "phishing-test-idempotency-key", egress);
		expect(create().egressPolicyRef).toBe("egress_tor@1");
		expect(create("phishing").egressPolicyRef).toBe("egress_tor@1");
		expect(create("reporting").egressPolicyRef).toBe("egress_direct@1");
		expect(create("residential").egressPolicyRef).toBe("egress_residential@1");

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
			{ operation: "provider-evidence-capture", reportId: "42", retry: false },
			"clone",
			"phishing-test-idempotency-key",
		);

		expect(payload).toEqual(expect.objectContaining({
			project: "project_phishing",
			runtime: "chrome",
			browserRecipeRef: "recipe_chrome@1",
			profileRef: "profile_default",
			leaseMode: "clone",
			metadata: {
				operation: "provider-evidence-capture",
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

	describe("a raw-CDP session for the browser task agent", () => {
		const relayUrl = process.env.FABRIC_CDP_RELAY_URL;
		beforeAll(() => { process.env.FABRIC_CDP_RELAY_URL = "http://fabric-cdp-relay:8085"; });
		afterAll(() => {
			if (relayUrl === undefined) delete process.env.FABRIC_CDP_RELAY_URL;
			else process.env.FABRIC_CDP_RELAY_URL = relayUrl;
		});

		function fakeFabric(responses: { create?: { status: number; body: unknown } } = {}) {
			const calls: Array<{ method: string; path: string; body?: unknown; idempotencyKey?: string | null }> = [];
			const config: FabricBrowserConfig = {
				...fabricBrowserConfigFromEnvironment({ environment: environment() })!,
				fetch: async (input, init) => {
					const path = new URL(String(input)).pathname;
					calls.push({ method: init?.method ?? "GET", path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}), idempotencyKey: new Headers(init?.headers).get("idempotency-key") });
					if (path === "/v1/browser-sessions") {
						const created = responses.create ?? { status: 201, body: { id: "browser-session_task", status: "queued" } };
						return Response.json(created.body, { status: created.status });
					}
					return Response.json({ id: "browser-session_task", status: "released" });
				},
			};
			return { config, calls };
		}

		test("leases a disposable clone on the requested egress and hands out only the relay route", async () => {
			const { config, calls } = fakeFabric();
			const session = await acquireFabricCdpSession({ operation: "provider-form", routeId: "7" }, { egress: "reporting" }, config);
			expect(session.id).toBe("browser-session_task");
			expect(session.cdpEndpoint).toBe("ws://fabric-cdp-relay:8085/v1/cdp/browser-session_task");
			expect(calls[0]).toMatchObject({
				method: "POST",
				path: "/v1/browser-sessions",
				body: {
					project: "project_phishing",
					runtime: "chrome",
					browserRecipeRef: "recipe_chrome@1",
					profileRef: "profile_default",
					leaseMode: "clone",
					egressPolicyRef: "egress_direct@1",
					maxExternalConnections: 1,
					metadata: { operation: "provider-form", routeId: "7", workload: "phishing-support" },
				},
			});
			expect(calls[0]!.idempotencyKey).toBe((calls[0]!.body as { idempotencyKey: string }).idempotencyKey);
			await session.release();
			await session.release();
			await session.cancel();
			// One lease transition, whatever the caller calls afterwards.
			expect(calls.slice(1).map((call) => `${call.method} ${call.path}`)).toEqual(["POST /v1/browser-sessions/browser-session_task/release"]);
		});

		test("cancels instead of releasing when the outcome is unknown", async () => {
			const { config, calls } = fakeFabric();
			const session = await acquireFabricCdpSession({}, { egress: "phishing" }, config);
			await session.cancel();
			await session.release();
			expect(calls.slice(1).map((call) => call.path)).toEqual(["/v1/browser-sessions/browser-session_task/cancel"]);
		});

		test("cancels the fresh lease when no valid relay route can be built for it", async () => {
			const { config, calls } = fakeFabric();
			process.env.FABRIC_CDP_RELAY_URL = "http://user:secret@fabric-cdp-relay:8085";
			try {
				await expect(acquireFabricCdpSession({}, { egress: "reporting" }, config)).rejects.toThrow("FABRIC_CDP_RELAY_URL");
			} finally {
				process.env.FABRIC_CDP_RELAY_URL = "http://fabric-cdp-relay:8085";
			}
			expect(calls.map((call) => call.path)).toEqual(["/v1/browser-sessions", "/v1/browser-sessions/browser-session_task/cancel"]);
		});

		test("surfaces Fabric's refusal (a recipe or policy the catalog does not have) without leasing anything", async () => {
			const refused = fakeFabric({ create: { status: 422, body: { detail: "unknown browser recipe recipe_rebrowser-phishing@1" } } });
			const refusal = await acquireFabricCdpSession({}, { egress: "reporting" }, refused.config).catch((error: unknown) => error);
			expect(refusal).toBeInstanceOf(BrowserUnavailableError);
			expect((refusal as Error).message).toStartWith("no browser was available (");
			expect((refusal as Error).message).toContain("unknown browser recipe recipe_rebrowser-phishing@1");
			expect(refused.calls).toHaveLength(1);
			const ended = fakeFabric({ create: { status: 201, body: { id: "browser-session_task", status: "failed" } } });
			await expect(acquireFabricCdpSession({}, { egress: "reporting" }, ended.config)).rejects.toThrow("Browser Fabric session ended in failed");
		});
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

	describe("a missing browser is typed through any wrapper", () => {
		test("finds BrowserUnavailableError anywhere in the cause chain, and nothing else", () => {
			const missing = new BrowserUnavailableError(new Error("Expected 101 status code"));
			expect(missing.message).toBe("no browser was available (Expected 101 status code)");
			expect(isBrowserUnavailable(missing)).toBeTrue();
			const login = new Error("Cloudflare dashboard login failed: no browser was available.", { cause: missing });
			expect(isBrowserUnavailable(new Error("job failed", { cause: login }))).toBeTrue();
			// The text alone never classifies: only the type does.
			expect(isBrowserUnavailable(new Error("no browser was available (Expected 101 status code)"))).toBeFalse();
			expect(isBrowserUnavailable(new Error("outer", { cause: "no browser was available" }))).toBeFalse();
			for (const value of [undefined, null, "no browser was available", { cause: missing }]) expect(isBrowserUnavailable(value)).toBeFalse();
		});

		test("terminates on a cyclic cause chain", () => {
			const a = new Error("a");
			const b = new Error("b", { cause: a });
			(a as { cause?: unknown }).cause = b;
			expect(isBrowserUnavailable(a)).toBeFalse();
		});
	});

	/**
	 * Regression of 2026-11-20/21: releasing a lease closed Patchright's
	 * process-wide in-process connection, so every later Patchright call in the
	 * process failed with "connectOverCDP: connectOverCDP: … Target page,
	 * context or browser has been closed" until a restart.
	 */
	describe.skipIf(!chromiumAvailable)("a Patchright lease through a relay to a real Chromium", () => {
		const relayUrl = process.env.FABRIC_CDP_RELAY_URL;
		let chromium: Awaited<ReturnType<typeof launchTestChromium>>;
		let relay: ReturnType<typeof Bun.serve>;
		let relayClientsClosed = 0;
		const fabricCalls: string[] = [];
		let sessions = 0;
		const config = (): FabricBrowserConfig => ({
			...fabricBrowserConfigFromEnvironment({ environment: environment() })!,
			fetch: async (input, init) => {
				const path = new URL(String(input)).pathname;
				fabricCalls.push(`${init?.method ?? "GET"} ${path}`);
				if (path === "/v1/browser-sessions") return Response.json({ id: `browser-session_lease${++sessions}`, status: "ready" }, { status: 201 });
				return Response.json({ status: "released" });
			},
		});

		beforeAll(async () => {
			chromium = await launchTestChromium();
			const upstreamUrl = chromium.wsEndpoint();
			// The relay: one upstream CDP WebSocket per client, like Fabric's.
			relay = Bun.serve<{ upstream?: WebSocket; pending: (string | Buffer)[] }>({
				port: 0,
				fetch(request, server) {
					return server.upgrade(request, { data: { pending: [] } }) ? undefined : new Response("upgrade", { status: 400 });
				},
				websocket: {
					open(client) {
						const upstream = new WebSocket(upstreamUrl);
						client.data.upstream = upstream;
						upstream.onopen = () => { for (const message of client.data.pending.splice(0)) upstream.send(message); };
						upstream.onmessage = (event) => client.send(event.data as string);
						upstream.onclose = () => client.close();
					},
					message(client, message) {
						const upstream = client.data.upstream!;
						if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
						else client.data.pending.push(message);
					},
					close(client) {
						relayClientsClosed += 1;
						client.data.upstream?.close();
					},
				},
			});
			process.env.FABRIC_CDP_RELAY_URL = `http://127.0.0.1:${relay.port}`;
		});
		afterAll(async () => {
			relay?.stop(true);
			await chromium?.close();
			if (relayUrl === undefined) delete process.env.FABRIC_CDP_RELAY_URL;
			else process.env.FABRIC_CDP_RELAY_URL = relayUrl;
		});

		test("releasing one lease drops only its own client: the next lease in the process still connects, and Chromium lives on", async () => {
			for (let lease = 1; lease <= 3; lease++) {
				const session = await acquireFabricPatchrightSession({ operation: "test" }, { egress: "reporting", leaseMode: "clone" }, config());
				const page = await session.context.newPage();
				expect(await page.evaluate(() => 6 * 7)).toBe(42);
				await page.close();
				await session.browser.close(); // the lease release, as callers use it
				await session.release();
				// Released exactly once, its transport closed at the relay.
				expect(fabricCalls.filter((call) => call.endsWith(`browser-session_lease${lease}/release`))).toHaveLength(1);
				await Bun.sleep(50);
				expect(relayClientsClosed).toBe(lease);
			}
			// The leased Chromium was never told Browser.close: only Fabric ends it.
			expect(chromium.connected).toBeTrue();
			expect((await chromium.pages()).length).toBeGreaterThan(0);
		}, 60_000);

		test("a relay that refuses the connection is a typed missing browser, and the lease is cancelled", async () => {
			const closed = Bun.serve({ port: 0, fetch: () => new Response("no such session", { status: 404 }) });
			process.env.FABRIC_CDP_RELAY_URL = `http://127.0.0.1:${closed.port}`;
			try {
				const error = await acquireFabricPatchrightSession({}, {}, config()).catch((thrown: unknown) => thrown);
				expect(error).toBeInstanceOf(BrowserUnavailableError);
				// One clean prefix: the message does not grow with each failed attempt.
				expect((error as Error).message).not.toContain("connectOverCDP: connectOverCDP:");
				expect(fabricCalls.at(-1)).toBe(`POST /v1/browser-sessions/browser-session_lease${sessions}/cancel`);
			} finally {
				closed.stop(true);
				process.env.FABRIC_CDP_RELAY_URL = `http://127.0.0.1:${relay.port}`;
			}
			// …and a missing browser never poisons the next lease.
			const session = await acquireFabricPatchrightSession({}, {}, config());
			await session.release();
		}, 240_000);
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

		test("recognizes a full relay in Patchright's words", async () => {
			let attempts = 0;
			const browser = await connectThroughRelay(
				async () => {
					attempts++;
					if (attempts < 3) throw new Error("connectOverCDP: WebSocket error: ws://fabric-relay-phishing:8085/v1/cdp/browser-session_abc 503 Service Unavailable\nCall log:\n  - <ws unexpected response> 503 Service Unavailable");
					return "browser";
				},
				async () => undefined,
				{ sleep: async () => undefined },
			);
			expect(browser).toBe("browser");
			expect(attempts).toBe(3);
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

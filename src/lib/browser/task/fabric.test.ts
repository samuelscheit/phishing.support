import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser } from "rebrowser-puppeteer-core";

import { runFabricBrowserTask, type FabricCdpSessionAcquirer } from "./fabric";
import { chromiumAvailable, html, launchTestChromium, refIn, ScriptedModel, StalledModel } from "./test_helpers";

const RESULT_SCHEMA = { type: "object", properties: { heading: { type: "string" } }, required: ["heading"], additionalProperties: false };

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const requests: string[] = [];

beforeAll(async () => {
	if (!chromiumAvailable) return;
	server = Bun.serve({
		port: 0,
		fetch: (request) => {
			const { pathname } = new URL(request.url);
			requests.push(pathname);
			if (pathname === "/upload") return html(`<h1>Evidence upload</h1><label>Evidence <input type="file" name="evidence"></label>`);
			return html(`<h1>Fixture heading</h1><a href="/next">Next</a>`);
		},
	});
	browser = await launchTestChromium();
});
afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

/** A lease on the test's own Chromium that records what the runner does with it. */
function lease() {
	const events: string[] = [];
	const acquire: FabricCdpSessionAcquirer = async (metadata, options) => {
		events.push(`acquire ${JSON.stringify(metadata)} ${options.egress}`);
		return {
			id: "browser-session_test",
			cdpEndpoint: browser.wsEndpoint(),
			release: async () => { events.push("release"); },
			cancel: async () => { events.push("cancel"); },
		};
	};
	return { acquire, events };
}

const pageTabs = async () => (await browser.pages()).length;

/** Target bookkeeping settles shortly after a tab closes. */
async function tabsSettleAt(count: number): Promise<number> {
	for (let attempt = 0; attempt < 40 && (await pageTabs()) !== count; attempt++) await Bun.sleep(50);
	return pageTabs();
}

describe.skipIf(!chromiumAvailable)("a browser task on a leased Fabric browser (real Chromium, scripted model)", () => {
	test("hands the session to the durable boundary before the agent acts, runs the task, and releases the browser", async () => {
		const { acquire, events } = lease();
		const tabsBefore = await pageTabs();
		requests.length = 0;
		const model = new ScriptedModel([
			(page) => {
				expect(page).toContain("Fixture heading");
				return { calls: [{ name: "done", arguments: { result: { heading: "Fixture heading" }, summary: "Read the heading." } }] };
			},
		]);
		const result = await runFabricBrowserTask({
			task: { goal: "Read the heading.", startUrl: `http://127.0.0.1:${server.port}/`, maxSteps: 3, resultSchema: RESULT_SCHEMA },
			model,
			egress: "reporting",
			metadata: { operation: "test" },
			timeoutMs: 30_000,
			started: async (sessionId) => {
				events.push(`started ${sessionId}`);
				// Nothing reached the page before the boundary was durable.
				expect(requests).toEqual([]);
				return true;
			},
			acquire,
		});
		expect(result).toMatchObject({ status: "done", result: { heading: "Fixture heading" } });
		expect(events).toEqual(['acquire {"operation":"test"} reporting', "started browser-session_test", "release"]);
		// The agent closed the tab it opened.
		expect(await tabsSettleAt(tabsBefore)).toBe(tabsBefore);
	}, 60_000);

	test("releases the browser without running anything when the work is no longer eligible", async () => {
		const { acquire, events } = lease();
		const model = new ScriptedModel([]);
		requests.length = 0;
		const result = await runFabricBrowserTask({
			task: { goal: "Read the heading.", startUrl: `http://127.0.0.1:${server.port}/`, maxSteps: 3, resultSchema: RESULT_SCHEMA },
			model,
			egress: "reporting",
			metadata: {},
			timeoutMs: 30_000,
			started: async () => false,
			acquire,
		});
		expect(result).toBeUndefined();
		expect(events.slice(1)).toEqual(["release"]);
		expect(model.requests).toHaveLength(0);
		expect(requests).toEqual([]);
	}, 60_000);

	test("cancels the browser when the run is aborted mid-task, because what it was doing is unknown", async () => {
		const { acquire, events } = lease();
		const controller = new AbortController();
		const running = runFabricBrowserTask({
			task: { goal: "Read the heading.", startUrl: `http://127.0.0.1:${server.port}/`, maxSteps: 3, resultSchema: RESULT_SCHEMA },
			model: new StalledModel(),
			egress: "reporting",
			metadata: {},
			timeoutMs: 30_000,
			started: async () => true,
			signal: controller.signal,
			acquire,
		});
		await Bun.sleep(1_500);
		controller.abort(new Error("worker stopping"));
		expect(await running).toMatchObject({ status: "failed", summary: "Aborted." });
		expect(events.at(-1)).toBe("cancel");
	}, 60_000);

	test("cancels the browser when the durable boundary itself fails", async () => {
		const { acquire, events } = lease();
		await expect(runFabricBrowserTask({
			task: { goal: "Read the heading.", startUrl: `http://127.0.0.1:${server.port}/`, maxSteps: 3, resultSchema: RESULT_SCHEMA },
			model: new ScriptedModel([]),
			egress: "reporting",
			metadata: {},
			timeoutMs: 30_000,
			started: async () => { throw new Error("database is locked"); },
			acquire,
		})).rejects.toThrow("database is locked");
		expect(events.at(-1)).toBe("cancel");
	}, 60_000);

	test("never uploads a file: no upload directory is allowed, so a file the model names is refused", async () => {
		const { acquire } = lease();
		let refusal = "";
		const model = new ScriptedModel([
			(page) => ({ calls: [{ name: "upload", arguments: { ref: refIn(page, "Evidence"), path: "/etc/hosts" } }] }),
			(page, request) => {
				// The upload tool is not even offered to the model.
				expect(request.tools?.map((tool) => tool.name)).not.toContain("upload");
				refusal = page;
				return { calls: [{ name: "done", arguments: { result: { heading: "Evidence upload" }, summary: "Could not upload." } }] };
			},
		]);
		const result = await runFabricBrowserTask({
			task: { goal: "Attach /etc/hosts.", startUrl: `http://127.0.0.1:${server.port}/upload`, maxSteps: 3, resultSchema: RESULT_SCHEMA },
			model,
			egress: "reporting",
			metadata: {},
			timeoutMs: 30_000,
			started: async () => true,
			acquire,
		});
		const upload = result?.steps[0]?.actions[0];
		expect(upload).toMatchObject({ tool: "upload", ok: false });
		expect(upload?.output).toContain("file uploads are disabled");
		expect(refusal).not.toContain("hosts");
	}, 60_000);
});

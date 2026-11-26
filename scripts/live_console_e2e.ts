/**
 * The live console end to end against a running `bun dev` (default
 * http://localhost:3000, or the first argument): a fixture visit
 * (`/dev/live-console/visit`) shows a sign-in form in a local headless
 * Chromium; a viewer in another headless Chromium opens the console, takes
 * over, clicks into the form, types, signs in and hands back, and then does
 * the same on a phone (taps, the keyboard button). Every step is checked in
 * the visited page itself.
 *
 *   bun scripts/live_console_e2e.ts [base URL] [screenshot directory]
 */
import puppeteer, { KnownDevices, type Page } from "rebrowser-puppeteer-core";

import { localChromium } from "../src/lib/browser/local_chromium";

const base = process.argv[2] ?? "http://localhost:3000";
const shots = process.argv[3];

type Visit = { mode: string; email: string; password: string; title: string; focused: string; emailAt: { x: number; y: number }; viewport: { width: number } };

async function openVisit() {
	const response = await fetch(`${base}/dev/live-console/visit`, { method: "POST" });
	if (!response.ok) throw new Error(`Could not open a fixture visit: ${response.status}`);
	const { id } = await response.json() as { id: string };
	return {
		id,
		read: async () => await (await fetch(`${base}/dev/live-console/visit?id=${id}`)).json() as Visit,
		close: () => fetch(`${base}/dev/live-console/visit?id=${id}`, { method: "DELETE" }),
	};
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, ms = 10_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}; last ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const badge = (page: Page, text: string) =>
	page.waitForFunction((label: string) => [...document.querySelectorAll("[role=status]")].some((element) => element.textContent?.trim() === label), { timeout: 15_000 }, text);

async function button(page: Page, text: string) {
	const handle = await page.waitForFunction((label: string) => [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label && element.getBoundingClientRect().width > 0 && !element.disabled), { timeout: 15_000 }, text);
	return handle.asElement() as unknown as { click(): Promise<void>; tap(): Promise<void> };
}

/** Where a point of the visited page is on the console's screen. */
async function onScreen(page: Page, visit: Visit, point: { x: number; y: number }) {
	const screen = await page.evaluateHandle(() => [...document.querySelectorAll('img[src^="blob:"]')].at(-1)!);
	const box = (await screen.asElement()!.boundingBox())!;
	const scale = box.width / visit.viewport.width;
	return { x: box.x + point.x * scale, y: box.y + point.y * scale };
}

async function open(page: Page, id: string) {
	page.on("pageerror", (error) => console.error("page error:", error instanceof Error ? error.message : error));
	await page.goto(`${base}/dev/live-console?state=live&id=${id}`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector('img[src^="blob:"]', { timeout: 60_000 });
}

async function desktop(browser: import("rebrowser-puppeteer-core").Browser) {
	const visit = await openVisit();
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1440, height: 900 });
		await open(page, visit.id);
		await page.click('[aria-label^="Open the live view"]');
		await (await button(page, "Take over")).click();
		await badge(page, "You're driving");
		const at = await onScreen(page, await visit.read(), (await visit.read()).emailAt);
		await page.mouse.click(at.x, at.y);
		await until(visit.read, (state) => state.focused === "email", "the click to focus the field");
		const text = "maria.keller@example.test";
		await page.keyboard.type(text, { delay: 15 });
		const typed = Date.now();
		await until(visit.read, (state) => state.email === text, "the typing to reach the page");
		console.log(`desktop: the last key reached the page ${Date.now() - typed} ms after it was pressed`);
		await page.keyboard.press("Tab");
		await page.keyboard.type("hunter2");
		await page.keyboard.press("Enter");
		const signedIn = await until(visit.read, (state) => state.title === "Signed in", "the form to be sent");
		if (signedIn.password !== "hunter2") throw new Error(`password ${JSON.stringify(signedIn.password)}`);
		if (shots) await page.screenshot({ path: `${shots}/desktop-driving.png` });
		await (await button(page, "Hand back")).click();
		await (await button(page, "Hand back to the agent")).click();
		await until(visit.read, (state) => state.mode === "agent", "the agent to drive again");
		await badge(page, "Agent driving");
		console.log("desktop: took over, signed in, handed back");
		await page.close();
	} finally {
		await visit.close();
	}
}

async function phone(browser: import("rebrowser-puppeteer-core").Browser) {
	const visit = await openVisit();
	try {
		const page = await browser.newPage();
		await page.emulate(KnownDevices["iPhone 13"]);
		await open(page, visit.id);
		await page.tap('[aria-label^="Open the live view"]');
		await (await button(page, "Take over")).tap();
		await badge(page, "You're driving");
		const at = await onScreen(page, await visit.read(), (await visit.read()).emailAt);
		await page.touchscreen.tap(at.x, at.y);
		await until(visit.read, (state) => state.focused === "email", "the tap to focus the field");
		await page.tap('[aria-label="Open the keyboard"]');
		await page.keyboard.type("phone@example.test");
		await until(visit.read, (state) => state.email === "phone@example.test", "the typing to reach the page");
		if (shots) await page.screenshot({ path: `${shots}/phone-driving.png` });
		console.log("phone: tapped into the field and typed with the keyboard button");
		await page.close();
	} finally {
		await visit.close();
	}
}

const browser = await puppeteer.launch({ executablePath: localChromium, headless: true });
try {
	await desktop(browser);
	await phone(browser);
} finally {
	await browser.close();
}

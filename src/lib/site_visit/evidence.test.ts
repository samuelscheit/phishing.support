import { describe, expect, test } from "bun:test";

import type { ClipboardWrite } from "../browser/clipboard";
import { createExfiltrationCanaries } from "../exfiltration/canaries";
import { visitPages } from "./evidence";

const page = (url: string) => ({ url, navigationHops: [{ index: 0, url, hostname: new URL(url).hostname, status: 200, contentCaptured: true }] });
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 26, 10, 0, seconds));
const copied = (text: string, seconds: number): ClipboardWrite => ({ text, documentUrl: "https://trylevo.app/", via: "writeText", at: at(seconds).toISOString() });

describe("what each page of a visit copied", () => {
	test("belongs to the page shown when it was written; the captured page's from its capture on", () => {
		const landing = page("https://trylevo.app/");
		const dialog = page("https://trylevo.app/#install");
		const done = page("https://trylevo.app/thanks");
		const writes = [
			// The capture clicked a verification gate that copied, before the visit began.
			copied("gate command", 1),
			copied("landing copy", 12),
			// Written the moment the dialog was recorded: the dialog shows from then on.
			copied("dialog copy", 20),
			copied("dialog copy again", 29),
			copied("after the last step", 45),
		];
		const pages = visitPages(landing, {
			startedAt: at(10),
			steps: [{ step: dialog, observedAt: at(20) }, { step: done, observedAt: at(30) }],
			requests: [],
			downloads: [],
			clipboardWrites: writes,
		}, createExfiltrationCanaries());
		expect(pages.map((shown) => [shown.archive.url, shown.clipboardWrites.map((write) => write.text)])).toEqual([
			[landing.url, ["gate command", "landing copy"]],
			[dialog.url, ["dialog copy", "dialog copy again"]],
			[done.url, ["after the last step"]],
		]);
		expect(pages[0]!.shownFrom).toEqual(at(10));
	});

	test("a visit that reached no page past the captured one gives it every write", () => {
		const landing = page("https://trylevo.app/");
		const [only] = visitPages(landing, { startedAt: at(10), steps: [], requests: [], downloads: [], clipboardWrites: [copied("early", 1), copied("late", 50)] }, createExfiltrationCanaries());
		expect(only!.clipboardWrites.map((write) => write.text)).toEqual(["early", "late"]);
	});
});

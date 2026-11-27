import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import puppeteer, { type Browser, type Page } from "rebrowser-puppeteer-core";

import type { VisitorTabs } from "@/lib/browser/visitor_tabs";
import { localChromium } from "@/lib/browser/local_chromium";
import { publishEvent } from "@/lib/event/event_transport";
import { createExfiltrationCanaries } from "@/lib/exfiltration/canaries";
import { closeVisitControl, openVisitControl, type VisitControl } from "@/lib/site_visit/control";
import { sleep } from "@/lib/util/sleep";
import { syntheticVisitValues } from "@/lib/site_visit/visit_task";

export const dynamic = "force-dynamic";

/**
 * A live visit without a case, an agent or the browser service: a local
 * headless Chromium shows a sign-in form, and a stand-in agent lets go
 * whenever someone takes over. For driving the real console end to end
 * (`/dev/live-console?state=live&id=…`; `scripts/live_console_e2e.ts`
 * drives it). Development only.
 *
 * POST opens one, GET `?id=` reads the form and the control's mode, DELETE `?id=` closes it.
 */

type FixtureVisit = { browser: Browser; page: Page; control: VisitControl; stop: AbortController };
const visits = ((globalThis as { __liveFixtureVisits?: Map<string, FixtureVisit> }).__liveFixtureVisits ??= new Map());

const FORM = `<!doctype html><title>SecureBank – Sign in</title><body style="font:16px system-ui;margin:0;background:#eef1f5">
<header style="background:#0d3b8e;color:#fff;padding:16px 24px;font-weight:700">SecureBank</header>
<form style="background:#fff;width:360px;margin:60px auto;padding:24px;border-radius:8px" onsubmit="event.preventDefault();document.title='Signed in'">
<label>Email<input id="email" name="email" style="display:block;width:100%;box-sizing:border-box;margin:6px 0 16px;padding:10px;font-size:16px"></label>
<label>Password<input id="password" type="password" style="display:block;width:100%;box-sizing:border-box;margin:6px 0 16px;padding:10px;font-size:16px"></label>
<button style="width:100%;padding:12px;background:#0d3b8e;color:#fff;border:0;font-size:16px">Continue</button></form></body>`;

const disabled = () => process.env.NODE_ENV === "production";

export async function POST() {
	if (disabled()) return new Response(null, { status: 404 });
	const id = `dev-live-${randomUUID()}`;
	const browser = await puppeteer.launch({ executablePath: localChromium, headless: true, args: ["--no-first-run"] });
	const page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 800 });
	await page.setContent(FORM);
	const tab = { targetId: "T1", session: await page.createCDPSession(), page, closed: false };
	const topic = `run:${id}`;
	const control = openVisitControl(id, (event) => void publishEvent(topic, event));
	control.attach({
		tabs: { first: tab, active: () => tab, tabs: () => [tab] } as unknown as VisitorTabs,
		touch: false,
		values: syntheticVisitValues(createExfiltrationCanaries()),
		recordStep: async () => true,
		onAction: (action) => void publishEvent(topic, { type: "browser.action", kind: action.kind, text: action.text, actor: action.actor }),
		onDriving: () => undefined,
	});
	const stop = new AbortController();
	// The stand-in agent: at its checkpoint between turns it lets a person drive until they hand back.
	void (async () => {
		while (!stop.signal.aborted) {
			await control.steering.checkpoint(stop.signal).catch(() => undefined);
			await sleep(300);
		}
	})();
	visits.set(id, { browser, page, control, stop });
	return Response.json({ id });
}

export async function GET(req: NextRequest) {
	if (disabled()) return new Response(null, { status: 404 });
	const visit = visits.get(req.nextUrl.searchParams.get("id") ?? "");
	if (!visit) return Response.json({ error: "No such visit." }, { status: 404 });
	const value = (selector: string) => visit.page.$eval(selector, (element: Element) => (element as HTMLInputElement).value);
	const email = await visit.page.$eval("#email", (element: Element) => {
		const box = element.getBoundingClientRect();
		return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
	});
	return Response.json({ mode: visit.control.mode, email: await value("#email"), password: await value("#password"), title: await visit.page.title(), focused: await visit.page.evaluate(() => document.activeElement?.id ?? ""), emailAt: email, viewport: visit.page.viewport() });
}

export async function DELETE(req: NextRequest) {
	if (disabled()) return new Response(null, { status: 404 });
	const id = req.nextUrl.searchParams.get("id") ?? "";
	const visit = visits.get(id);
	if (!visit) return Response.json({ error: "No such visit." }, { status: 404 });
	visits.delete(id);
	visit.stop.abort();
	await closeVisitControl(visit.control);
	await visit.browser.close();
	return Response.json({ ok: true });
}

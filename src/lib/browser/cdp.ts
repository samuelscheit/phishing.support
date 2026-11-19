import type { CDPSession } from "rebrowser-puppeteer-core";

/**
 * Send a command a held tab answers only once it runs (Network, Page,
 * Emulation; the browser's own Target, Browser and Fetch answer at once).
 * Sent before the tab is let run, it takes effect before the tab's first
 * request, as puppeteer relies on for its own setup. Its answer, which a
 * held tab gives only once it runs, resolves the promise; waiting for it
 * before the tab runs would deadlock it. It never rejects.
 */
export function sendBeforeRun(session: CDPSession, ...command: Parameters<CDPSession["send"]>): Promise<unknown> {
	return session.send(...command).catch(() => undefined);
}

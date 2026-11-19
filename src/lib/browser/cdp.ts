import type { CDPSession } from "rebrowser-puppeteer-core";

/**
 * Send a command a held tab answers only once it runs (Network, Page,
 * Emulation; the browser's own Target, Browser and Fetch answer at once).
 * Sent before the tab is let run, it takes effect before the tab's first
 * request, as puppeteer relies on for its own setup; its answer is not
 * waited for, which would deadlock the held tab.
 */
export function sendBeforeRun(session: CDPSession, ...command: Parameters<CDPSession["send"]>): void {
	void session.send(...command).catch(() => undefined);
}

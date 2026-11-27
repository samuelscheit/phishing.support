import type { Browser, CDPSession, Page, Target } from "rebrowser-puppeteer-core";

import { sendBeforeRun } from "./cdp";
import { sleep } from "../util/sleep";

/**
 * The tabs of one visit: the captured tab, and every tab a visited tab opens
 * (a target=_blank link, window.open, a form with a target), which the
 * visiting agent follows. A new tab is held before it runs its first request,
 * so whatever records the visit sees its first load whole; puppeteer only
 * makes its page once that load is under way.
 */
export type VisitorTab = {
	targetId: string;
	/** The tab's raw CDP session, with the Network domain enabled before the tab ran. */
	session: CDPSession;
	/** The tab that opened it; the captured tab has none. */
	opener?: VisitorTab;
	/** The tab's page, once puppeteer has made it; a tab that only delivered a file may never get one. */
	page?: Page;
	/** Resolves with the page once it exists. */
	pageReady: Promise<Page>;
	/**
	 * Answers of commands sent while the tab was held that its first page
	 * must have applied before it is shown: the screen size reaches the page
	 * on its own path, after its first script under load.
	 */
	beforeFirstPage: Promise<unknown>[];
	/** Set by a setup that keeps the raw body of every page the tab's main frame is answered with. */
	recordDocumentAnswer?: (answer: { url: string; status: number; receivedAt: string; body?: Buffer }) => void;
	closed: boolean;
};

/**
 * Prepares a tab before it runs: listeners and domains on its session. A held
 * tab answers the commands its page handles (Network, Page, Emulation) only
 * once it runs, so a setup sends those with `sendBeforeRun` and never waits
 * for their answers; it may wait for the browser's own (Target, Browser,
 * Fetch). A failing setup leaves the tab to run unprepared by it.
 */
export type TabSetup = (tab: VisitorTab) => Promise<void> | void;

const CLOSE_ATTEMPTS = 5;
/** How long a close is given to be confirmed before it is asked for again. */
const CLOSE_CONFIRM_MS = 500;

type AttachedEvent = { sessionId: string; waitingForDebugger: boolean; targetInfo: { targetId: string; type: string; openerId?: string } };

/** A target's id, which is also the id of a page target's main frame. */
export function targetIdOf(target: Target): string {
	return (target as unknown as { _targetId: string })._targetId;
}

export class VisitorTabs {
	readonly first: VisitorTab;
	readonly #tabs = new Map<string, VisitorTab>();
	readonly #order: VisitorTab[] = [];
	readonly #pages = new Map<string, PromiseWithResolvers<Page>>();
	readonly #setups: TabSetup[] = [];
	readonly #pending = new Set<Promise<unknown>>();
	#stopped = false;
	/** Puppeteer made the page of a target: a tab of the visit gets it. */
	readonly #onTargetCreated = (target: Target): void => {
		if (target.type() !== "page") return;
		const id = targetIdOf(target);
		void target.page().then((page) => { if (page) this.#page(id).resolve(page); }, () => undefined);
	};

	private constructor(
		private readonly browser: Browser,
		private readonly control: CDPSession,
		first: VisitorTab,
	) {
		this.first = first;
		this.#register(first);
	}

	/**
	 * Watch the browser for tabs opened from `page` (and from those tabs).
	 * Every setup runs on each tab before it runs: on the captured tab now,
	 * on a new tab while it is held.
	 */
	static async start(browser: Browser, page: Page, setups: readonly TabSetup[] = []): Promise<VisitorTabs> {
		const control = await browser.target().createCDPSession();
		// The captured tab's own traffic is recorded through puppeteer; its session carries downloads and the screencast.
		const session = await page.target().createCDPSession().catch(async (error: unknown) => {
			await control.detach().catch(() => undefined);
			throw error;
		});
		const first: VisitorTab = { targetId: targetIdOf(page.target()), session, page, pageReady: Promise.resolve(page), beforeFirstPage: [], closed: false };
		const tabs = new VisitorTabs(browser, control, first);
		try {
			browser.on("targetcreated", tabs.#onTargetCreated);
			control.on("Target.attachedToTarget", (event: AttachedEvent) => tabs.#track(tabs.#attached(event)));
			control.on("Target.targetDestroyed", (event: { targetId: string }) => tabs.#closed(event.targetId));
			for (const setup of setups) {
				tabs.#setups.push(setup);
				await setup(first);
			}
			await control.send("Target.setDiscoverTargets", { discover: true });
			await control.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page", exclude: false }] });
			return tabs;
		} catch (error) {
			await tabs.stop();
			throw error;
		}
	}

	/**
	 * The visitor's tab once the newest tab the site opened has its page:
	 * a walk that ended right after opening a tab ended on that tab, which
	 * puppeteer may not have made a page for yet.
	 */
	async settled(timeoutMs: number): Promise<VisitorTab> {
		const newest = this.#order.findLast((tab) => !tab.closed);
		if (newest && !newest.page) await Promise.race([newest.pageReady, sleep(timeoutMs)]).catch(() => undefined);
		return this.active();
	}

	/** The tab the visitor is on: the newest open tab that shows a page, as the agent follows it. */
	active(): VisitorTab {
		return this.#order.findLast((tab) => !tab.closed && tab.page) ?? this.first;
	}

	tabs(): readonly VisitorTab[] {
		return this.#order;
	}

	/** A person switched to this tab: it is the visitor's tab, in front, until the site opens another. */
	async focus(tab: VisitorTab): Promise<void> {
		const index = this.#order.indexOf(tab);
		if (index < 0 || tab.closed || !tab.page) return;
		this.#order.splice(index, 1);
		this.#order.push(tab);
		await this.control.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => undefined);
	}

	#page(targetId: string): PromiseWithResolvers<Page> {
		let page = this.#pages.get(targetId);
		if (!page) this.#pages.set(targetId, page = Promise.withResolvers<Page>());
		return page;
	}

	#register(tab: VisitorTab): void {
		this.#tabs.set(tab.targetId, tab);
		this.#order.push(tab);
	}

	#track(work: Promise<unknown>): void {
		const tracked = work.catch(() => undefined).finally(() => this.#pending.delete(tracked));
		this.#pending.add(tracked);
	}

	async #attached(event: AttachedEvent): Promise<void> {
		const { targetInfo, sessionId } = event;
		const session = this.control.connection()?.session(sessionId);
		const opener = targetInfo.openerId ? this.#tabs.get(targetInfo.openerId) : undefined;
		if (!session || !opener || this.#tabs.has(targetInfo.targetId) || this.#stopped) {
			// Not a tab of the visit (or the visitor's tab, which has its own session): let it run untouched. A session
			// left attached would reset its navigator.platform, so it is detached also when puppeteer made no object for it.
			if (event.waitingForDebugger) await session?.send("Runtime.runIfWaitingForDebugger").catch(() => undefined);
			await this.control.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
			return;
		}
		const page = this.#page(targetInfo.targetId);
		const tab: VisitorTab = { targetId: targetInfo.targetId, session, opener, pageReady: page.promise, beforeFirstPage: [], closed: false };
		void page.promise.then((ready) => { tab.page = ready; });
		// A tab an earlier visit of this browser opened already has its page.
		const known = this.browser.targets().find((target) => targetIdOf(target) === targetInfo.targetId);
		if (known) this.#onTargetCreated(known);
		this.#register(tab);
		try {
			void sendBeforeRun(session, "Network.enable");
			for (const setup of this.#setups) await Promise.resolve(setup(tab)).catch(() => undefined);
		} finally {
			// Held until here: the tab runs its first request only now. A tab whose first
			// request turned into a download answers this only once it is gone.
			void sendBeforeRun(session, "Runtime.runIfWaitingForDebugger");
		}
	}

	/**
	 * Close a tab the site opened: Chrome closes a new tab whose link only
	 * delivered a file, and the visitor is back on its opener.
	 */
	async close(tab: VisitorTab): Promise<void> {
		if (tab === this.first || tab.closed) return;
		// Chrome answers success but drops the request while the aborted download's
		// error page commits, so the close is repeated until the target is gone.
		for (let attempt = 0; attempt < CLOSE_ATTEMPTS && !tab.closed; attempt++) {
			const destroyed = this.#destroyed(tab.targetId);
			if (!(await this.control.send("Target.closeTarget", { targetId: tab.targetId }).then(() => true, () => false))) return;
			await Promise.race([destroyed, sleep(CLOSE_CONFIRM_MS)]);
		}
	}

	/** Resolves when the target is destroyed. */
	#destroyed(targetId: string): Promise<void> {
		return new Promise((resolve) => {
			const onDestroyed = (event: { targetId: string }) => {
				if (event.targetId !== targetId) return;
				this.control.off("Target.targetDestroyed", onDestroyed);
				resolve();
			};
			this.control.on("Target.targetDestroyed", onDestroyed);
			setTimeout(() => this.control.off("Target.targetDestroyed", onDestroyed), CLOSE_CONFIRM_MS);
		});
	}

	#closed(targetId: string): void {
		const tab = this.#tabs.get(targetId);
		if (tab && tab !== this.first) tab.closed = true;
	}

	/** Stop watching; every tab keeps running. */
	async stop(): Promise<void> {
		this.#stopped = true;
		this.browser.off("targetcreated", this.#onTargetCreated);
		await this.control.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false }).catch(() => undefined);
		await Promise.allSettled([...this.#pending]);
		await this.control.detach().catch(() => undefined);
		for (const tab of this.#order) await tab.session.detach().catch(() => undefined);
	}
}

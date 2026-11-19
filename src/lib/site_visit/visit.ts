import type { Browser, CDPSession, Page } from "rebrowser-puppeteer-core";

import { VisitorTabs, type TabSetup, type VisitorTab } from "../browser/visitor_tabs";
import { errorText } from "../error_text";
import { ExfiltrationNetworkRecorder } from "../exfiltration/recorder";
import type { CapturedNetworkRequest, ExfiltrationCanaries } from "../exfiltration/types";
import { interceptDownloads, type DownloadedFile, type DownloadInterceptor, type FailedDownload } from "../website_download";
import { revealSyntheticSecret, type VisitAgent, type VisitAgentAction, type VisitAgentState } from "./agent";
import { buildSiteVisitTask, visitAgentReport, VISIT_BUDGET_MS, type VisitAgentReport } from "./task";

/**
 * One visit of a reported site, the way its victim goes through it: the
 * capture has loaded the page, then an agent walks the site in that same
 * browser and tab, entering only synthetic values, while the visit records
 * what the evidence needs: each page it reaches, every request (where the
 * synthetic values go), and every file it downloads. The agent follows the
 * site into every tab it opens, and so does the recording. The agent only
 * moves; what it reports about itself is never evidence.
 */

/** Pages recorded per visit beyond the first; a site that changes forever cannot hold it open. */
const MAX_STEPS = 12;
const POLL_MS = 1_000;
/** A page change is recorded once the page has stayed the same this long. */
const STEP_QUIET_MS = 2_000;
/** How long the final step waits for a tab the walk opened last to have its page. */
const FINAL_TAB_WAIT_MS = 5_000;
/** Screencast frames published per second at most. */
const LIVE_FRAMES_PER_SECOND = 3;

/** What a visit shows while it runs: the tab's screen, each recorded page, and the agent's actions. */
export type SiteVisitLiveEvent =
	| { type: "browser.frame"; jpeg: string; url: string }
	| { type: "browser.step"; index: number; url: string; title: string }
	| { type: "browser.action"; kind: string; text: string }
	| { type: "browser.download"; fileName: string; url: string };

export type SiteVisitAgentOutcome = {
	/** `completed`: the agent finished; `failed`: it failed or could not start; `timed_out`: the visit's budget ended it. */
	outcome: "completed" | "failed" | "timed_out";
	report?: VisitAgentReport;
	failure?: string;
	actions: VisitAgentAction[];
};

export type SiteVisitRecording<Step> = {
	/** When the agent began; the captured page was shown from then until the first step. */
	startedAt: Date;
	/** Each page the visit reached after the captured one, in order. */
	steps: Array<{ step: Step; observedAt: Date }>;
	requests: CapturedNetworkRequest[];
	downloads: DownloadedFile[];
	downloadFailures: FailedDownload[];
	agent: SiteVisitAgentOutcome;
};

export type SiteVisitParams<Step> = {
	browser: Browser;
	page: Page;
	/** Where the agent attaches to the same browser. */
	agentAddress: string;
	userAgent: string;
	url: string;
	canaries: ExfiltrationCanaries;
	agent: VisitAgent;
	/** Extra instructions for the visiting agent, on top of the walk itself. */
	instructions?: string;
	/** Prepares each tab the site opens before it runs, on top of the visit's own recording. */
	tabSetup?: TabSetup;
	/** Record the tab's page as it stands as the visit's next step. */
	snapshot: (tab: VisitorTab) => Promise<Step>;
	live?: (event: SiteVisitLiveEvent) => void;
	budgetMs?: number;
	signal?: AbortSignal;
	/** Test seam for the waits between polls. */
	pollMs?: number;
	stepQuietMs?: number;
};

/** The page's address and a fingerprint of what it shows, to tell one step from the next. */
async function pageState(page: Page): Promise<{ url: string; text: string; title: string } | undefined> {
	return page.evaluate(() => ({ url: location.href, text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 20_000), title: document.title }))
		.catch(() => undefined);
}

/** The tab's screen, as frames for the live view: a few per second, small. */
async function startScreencast(cdp: CDPSession, page: Page, live: (event: SiteVisitLiveEvent) => void): Promise<() => Promise<void>> {
	let last = 0;
	const onFrame = (frame: { data: string; sessionId: number }) => {
		void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
		const now = Date.now();
		if (now - last < 1_000 / LIVE_FRAMES_PER_SECOND) return;
		last = now;
		live({ type: "browser.frame", jpeg: frame.data, url: page.url() });
	};
	cdp.on("Page.screencastFrame", onFrame);
	await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 960, maxHeight: 720, everyNthFrame: 2 });
	return async () => {
		cdp.off("Page.screencastFrame", onFrame);
		await cdp.send("Page.stopScreencast").catch(() => undefined);
	};
}

/** The live view of whichever tab the visitor is on: it moves along when the agent follows the site into another tab. */
function followingScreencast(tabs: VisitorTabs, live: (event: SiteVisitLiveEvent) => void) {
	let shown: VisitorTab | undefined;
	let stop: (() => Promise<void>) | undefined;
	return {
		async follow() {
			const tab = tabs.active();
			if (tab === shown || !tab.page) return;
			await stop?.();
			shown = tab;
			stop = await startScreencast(tab.session, tab.page, live).catch(() => undefined);
		},
		async stop() {
			await stop?.();
		},
	};
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}

/**
 * Walk the site with the agent and record it. The visit never throws for
 * what the agent does: a failed or late agent ends the walk, and what was
 * recorded up to then is returned with the outcome. A broken browser throws.
 */
export async function runSiteVisit<Step>(params: SiteVisitParams<Step>): Promise<SiteVisitRecording<Step>> {
	const { browser, page, agent, live = () => undefined } = params;
	const pollMs = params.pollMs ?? POLL_MS;
	const quietMs = params.stepQuietMs ?? STEP_QUIET_MS;
	const budget = AbortSignal.timeout(params.budgetMs ?? VISIT_BUDGET_MS);
	const stopped = params.signal ? AbortSignal.any([budget, params.signal]) : budget;

	const startedAt = new Date();
	const network = new ExfiltrationNetworkRecorder();
	await network.start(browser);
	let tabs: VisitorTabs | undefined;
	let screencast: ReturnType<typeof followingScreencast> | undefined;
	const steps: SiteVisitRecording<Step>["steps"] = [];
	const actions: VisitAgentAction[] = [];
	const agentOutcome: SiteVisitAgentOutcome = { outcome: "failed", actions };
	// A tab the site opened only to deliver a file is closed once it did, as Chrome closes it.
	const downloads: DownloadInterceptor<VisitorTab> = interceptDownloads<VisitorTab>(params.userAgent, (tab, showedPage) => {
		if (tab.opener && !showedPage) void tabs?.close(tab);
	});
	try {
		tabs = await VisitorTabs.start(browser, page, [
			// Every request of a tab the site opens, from its first, and every file any tab downloads.
			(tab) => network.attachSession(tab.targetId, tab.session),
			(tab) => downloads.attach(tab),
			...(params.tabSetup ? [params.tabSetup] : []),
		]);
		const visitorTabs = tabs;
		screencast = followingScreencast(visitorTabs, live);
		await screencast.follow();

		let recorded = await pageState(page);
		let pending: { url: string; text: string; since: number } | undefined;
		let announcedDownloads = 0;
		/** Record the visitor's tab once its page has changed and then stayed the same for the quiet period. */
		const recordStep = async (force = false) => {
			if (steps.length >= MAX_STEPS) return;
			const tab = visitorTabs.active();
			const state = tab.page ? await pageState(tab.page) : undefined;
			if (!state || (state.url === recorded?.url && state.text === recorded?.text)) {
				pending = undefined;
				return;
			}
			if (!force && (!pending || pending.url !== state.url || pending.text !== state.text)) {
				pending = { url: state.url, text: state.text, since: Date.now() };
				return;
			}
			if (!force && Date.now() - pending!.since < quietMs) return;
			pending = undefined;
			recorded = state;
			const step = await params.snapshot(tab);
			steps.push({ step, observedAt: new Date() });
			live({ type: "browser.step", index: steps.length, url: state.url, title: state.title });
		};
		const announceDownloads = () => {
			for (const file of downloads.files().slice(announcedDownloads)) live({ type: "browser.download", fileName: file.fileName, url: file.url });
			announcedDownloads = downloads.files().length;
		};

		let walk: Promise<VisitAgentState> | undefined;
		try {
			const task = buildSiteVisitTask(params.url, params.canaries, undefined, params.instructions);
			walk = agent({
				task,
				cdpEndpoint: params.agentAddress,
				targetId: visitorTabs.first.targetId,
				signal: stopped,
				onAction: (logged) => {
					const action = revealSyntheticSecret(logged, params.canaries);
					actions.push(action);
					live({ type: "browser.action", kind: action.kind, text: action.text });
				},
			}).catch((error: unknown) => ({ state: "failed" as const, reason: errorText(error).slice(0, 300) }));
		} catch (error) {
			agentOutcome.failure = `The visiting agent could not start: ${errorText(error).slice(0, 300)}`;
		}

		if (walk) {
			let ended: VisitAgentState | undefined;
			void walk.then((state) => { ended = state; });
			while (!ended && !stopped.aborted) {
				await Promise.race([sleep(pollMs, stopped), walk]);
				await screencast.follow();
				await recordStep();
				announceDownloads();
			}
			// An aborted walk winds down on its own signal; wait for it so it no longer acts.
			const state = ended ?? await walk;
			if (stopped.aborted && state.state !== "completed") {
				agentOutcome.outcome = "timed_out";
				agentOutcome.failure = budget.aborted ? `The visit's ${Math.round((params.budgetMs ?? VISIT_BUDGET_MS) / 60_000)}-minute budget ended the walk.` : "The visit was canceled.";
			} else if (state.state === "completed") {
				agentOutcome.outcome = "completed";
				const report = visitAgentReport(state.output);
				if (report) agentOutcome.report = report;
			} else {
				agentOutcome.failure = state.reason;
			}
		}
		// The page the walk ended on is a step of its own, whatever the quiet period,
		// also when the walk ended right after opening a tab puppeteer has no page for yet.
		await tabs.settled(FINAL_TAB_WAIT_MS);
		await recordStep(true);
		await downloads.settled();
		announceDownloads();
		return {
			startedAt,
			steps,
			requests: await network.stop(),
			downloads: downloads.files(),
			downloadFailures: downloads.failures(),
			agent: agentOutcome,
		};
	} finally {
		await network.stop().catch(() => undefined);
		await screencast?.stop();
		for (const tab of tabs?.tabs() ?? []) await tab.session.send("Fetch.disable").catch(() => undefined);
		await tabs?.stop();
	}
}

import type { Browser, Page, Protocol } from "rebrowser-puppeteer-core";

import type { ClipboardRecorder, ClipboardWrite } from "../browser/clipboard";
import { VisitorTabs, type TabSetup, type VisitorTab } from "../browser/visitor_tabs";
import { errorText } from "../util/error_text";
import { ExfiltrationNetworkRecorder } from "../exfiltration/recorder";
import type { CapturedNetworkRequest, ExfiltrationCanaries } from "../exfiltration/types";
import { interceptDownloads, type DownloadedFile, type DownloadInterceptor, type FailedDownload } from "../website/visit/download";
import { revealSyntheticSecret, type VisitAgent, type VisitAgentAction, type VisitAgentState } from "./agent";
import { buildSiteVisitTask, syntheticVisitValues, visitAgentReport, VISIT_BUDGET_MS, type VisitAgentReport } from "./visit_task";
import { sleep } from "../util/sleep";
import { pausableTimeout } from "../util/pausable_timeout";
import type { VisitControl, VisitControlEvent } from "./control";

/**
 * One visit of a reported site, the way its victim goes through it: the
 * recording starts on the visitor's tab before the site loads, the page is
 * loaded and captured, then an agent may walk the site in that same browser
 * and tab, entering only synthetic values, while the recording keeps what
 * the evidence needs: each page it reaches, every request (where the
 * synthetic values go), every file it downloads, and everything its pages
 * put on the clipboard, from the first request of the first load on. The
 * agent follows the site into every tab it opens, and so does the
 * recording. The agent only moves; what it reports about itself is never
 * evidence.
 */

/** Pages recorded per visit beyond the first; a site that changes forever cannot hold it open. */
const MAX_STEPS = 12;
/** The same once a person took the browser over: they go further, and record pages on purpose. */
const MAX_STEPS_WITH_PERSON = 24;
const POLL_MS = 1_000;
/** A page change is recorded once the page has stayed the same this long. */
const STEP_QUIET_MS = 2_000;
/** How long the final step waits for a tab the walk opened last to have its page. */
const FINAL_TAB_WAIT_MS = 5_000;

/**
 * What a visit tells its viewers while it runs: each recorded page, every
 * action (the agent's or a person's), downloads, and who drives. The screen
 * itself goes to viewers through the control's `LiveScreen`, never through
 * the event history.
 */
export type SiteVisitLiveEvent =
	| { type: "browser.step"; index: number; url: string; title: string }
	| { type: "browser.action"; kind: string; text: string; actor: "agent" | "human" }
	| { type: "browser.download"; fileName: string; url: string }
	| VisitControlEvent;

type SiteVisitAgentOutcome = {
	/** `completed`: the agent finished; `failed`: it failed or could not start; `timed_out`: the visit's budget ended it. */
	outcome: "completed" | "failed" | "timed_out";
	report?: VisitAgentReport;
	failure?: string;
	actions: VisitAgentAction[];
};

export type SiteVisitRecording<Step> = {
	/** When the agent began; the captured page was shown from its load until the first step. */
	startedAt: Date;
	/** Each page the visit reached after the captured one, in order. */
	steps: Array<{ step: Step; observedAt: Date }>;
	requests: CapturedNetworkRequest[];
	downloads: DownloadedFile[];
	downloadFailures: FailedDownload[];
	/** What the pages put on the clipboard, since the site first loaded. */
	clipboardWrites: ClipboardWrite[];
	agent: SiteVisitAgentOutcome;
};

export type SiteRecordingParams = {
	browser: Browser;
	/** The visitor's tab, before it loads the site. */
	page: Page;
	/**
	 * The identity the tab presents. Chromium resets a document's
	 * navigator.platform when a session without it attaches, so every
	 * session the recording holds on the tab presents it too.
	 */
	userAgentOverride: Protocol.Emulation.SetUserAgentOverrideRequest;
	/** Prepares each tab the site opens before it runs, on top of the recording's own. */
	tabSetup?: TabSetup;
	/** Records the visitor's tab's clipboard writes; the recording adds each tab the site opens. */
	clipboard: ClipboardRecorder;
};

export type SiteWalkParams<Step> = {
	/** Where the agent attaches to the same browser. */
	agentAddress: string;
	url: string;
	canaries: ExfiltrationCanaries;
	agent: VisitAgent;
	/** Extra instructions for the visiting agent, on top of the walk itself. */
	instructions?: string;
	/** Record the tab's page as it stands as the visit's next step. */
	snapshot: (tab: VisitorTab) => Promise<Step>;
	live?: (event: SiteVisitLiveEvent) => void;
	/** Lets people watching the visit drive it; without one, only the agent does. */
	control?: VisitControl;
	/** The tab emulates a touch screen (a phone capture): a person's pointer is a finger. */
	touch?: boolean;
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

/** A visit's recording, running from before the site loads: the visitor's tabs, and the walk it may take. */
export type SiteRecording = {
	/** The visitor's tabs; the first is the tab the site loads in. */
	tabs: VisitorTabs;
	/** Walk the site with the agent from the tab's page; once per recording. */
	walk<Step>(params: SiteWalkParams<Step>): Promise<SiteVisitRecording<Step>>;
	/** Stop recording; every tab keeps running. Idempotent. */
	stop(): Promise<void>;
};

/**
 * Start recording a visit on the visitor's tab before it loads the site:
 * every request of every tab (where the synthetic values go), every file
 * any tab downloads (a drive-by download of the first load included), and
 * what each tab the site opens puts on the clipboard.
 */
export async function startSiteRecording(params: SiteRecordingParams): Promise<SiteRecording> {
	const { browser, page, clipboard } = params;
	const network = new ExfiltrationNetworkRecorder();
	let tabs: VisitorTabs | undefined;
	// A tab the site opened only to deliver a file is closed once it did, as Chrome closes it.
	const downloads: DownloadInterceptor<VisitorTab> = interceptDownloads<VisitorTab>(params.userAgentOverride.userAgent, (tab, showedPage) => {
		if (tab.opener && !showedPage) void tabs?.close(tab);
	});
	let stopping: Promise<void> | undefined;
	const stop = () => stopping ??= (async () => {
		await network.stop().catch(() => undefined);
		for (const tab of tabs?.tabs() ?? []) await tab.session.send("Fetch.disable").catch(() => undefined);
		await tabs?.stop();
	})();
	try {
		await network.start(browser, { userAgentOverride: params.userAgentOverride });
		tabs = await VisitorTabs.start(browser, page, [
			// The visitor's tab's own session keeps its identity; a tab the site opens is given it by `tabSetup`.
			(tab) => (tab.opener ? undefined : tab.session.send("Emulation.setUserAgentOverride", params.userAgentOverride)),
			// Every file any tab downloads.
			(tab) => downloads.attach(tab),
			...(params.tabSetup ? [params.tabSetup] : []),
			// What every tab the site opens puts on the clipboard; it is held until then.
			(tab) => (tab.opener ? clipboard.attach(tab.session, { held: true }) : undefined),
		]);
	} catch (error) {
		await stop();
		throw error;
	}
	const visitorTabs = tabs;
	let walked = false;
	return {
		tabs: visitorTabs,
		walk: async <Step>(walk: SiteWalkParams<Step>) => {
			if (walked) throw new Error("The visit was walked already.");
			if (stopping) throw new Error("The visit's recording has stopped.");
			walked = true;
			return walkSite({ ...walk, page, tabs: visitorTabs, network, downloads, clipboard });
		},
		stop,
	};
}

/**
 * Walk the site with the agent and record it. The visit never throws for
 * what the agent does: a failed or late agent ends the walk, and what was
 * recorded up to then is returned with the outcome. A broken browser throws.
 */
async function walkSite<Step>(params: SiteWalkParams<Step> & { page: Page; tabs: VisitorTabs; network: ExfiltrationNetworkRecorder; downloads: DownloadInterceptor<VisitorTab>; clipboard: ClipboardRecorder }): Promise<SiteVisitRecording<Step>> {
	const { page, agent, control, network, downloads, tabs: visitorTabs, live = () => undefined } = params;
	const pollMs = params.pollMs ?? POLL_MS;
	const quietMs = params.stepQuietMs ?? STEP_QUIET_MS;
	// The visit's clock stops while a person drives; their own turns are limited by the control.
	const clock = pausableTimeout(params.budgetMs ?? VISIT_BUDGET_MS);
	const budget = clock.signal;
	const stopped = params.signal ? AbortSignal.any([budget, params.signal]) : budget;

	const startedAt = new Date();
	const steps: SiteVisitRecording<Step>["steps"] = [];
	const actions: VisitAgentAction[] = [];
	const agentOutcome: SiteVisitAgentOutcome = { outcome: "failed", actions };
	try {
		let recorded = await pageState(page);
		let pending: { url: string; text: string; since: number } | undefined;
		let announcedDownloads = 0;
		/** Record the visitor's tab once its page has changed and then stayed the same for the quiet period. */
		/** Whether it recorded a step. */
		const recordChangedStep = async (force: boolean): Promise<boolean> => {
			if (steps.length >= (control?.tookOver ? MAX_STEPS_WITH_PERSON : MAX_STEPS)) return false;
			const tab = visitorTabs.active();
			const state = tab.page ? await pageState(tab.page) : undefined;
			if (!state || (state.url === recorded?.url && state.text === recorded?.text)) {
				pending = undefined;
				return false;
			}
			if (!force && (!pending || pending.url !== state.url || pending.text !== state.text)) {
				pending = { url: state.url, text: state.text, since: Date.now() };
				return false;
			}
			if (!force && Date.now() - pending!.since < quietMs) return false;
			pending = undefined;
			const step = await params.snapshot(tab);
			// Only a page whose snapshot was taken counts as recorded: one that failed is tried again.
			recorded = state;
			steps.push({ step, observedAt: new Date() });
			live({ type: "browser.step", index: steps.length, url: state.url, title: state.title });
			return true;
		};
		// The poll and a person's "record this page" never snapshot at the same time.
		let recording: Promise<boolean> = Promise.resolve(false);
		const recordStep = (force = false) => (recording = recording.catch(() => false).then(() => recordChangedStep(force)));
		const publishAction = (action: VisitAgentAction) => {
			if (!actions.includes(action)) actions.push(action);
			live({ type: "browser.action", kind: action.kind, text: action.text, actor: action.actor });
		};
		control?.attach({
			tabs: visitorTabs,
			touch: params.touch ?? false,
			values: syntheticVisitValues(params.canaries),
			recordStep: () => recordStep(true),
			onAction: publishAction,
			onDriving: (driving) => (driving ? clock.pause() : clock.resume()),
		});
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
				...(control ? { steering: control.steering } : {}),
				onAction: (logged) => publishAction(revealSyntheticSecret(logged, params.canaries)),
			}).catch((error: unknown) => ({ state: "failed" as const, reason: errorText(error).slice(0, 300) }));
		} catch (error) {
			agentOutcome.failure = `The visiting agent could not start: ${errorText(error).slice(0, 300)}`;
			control?.agentEnded();
		}

		if (walk) {
			let ended: VisitAgentState | undefined;
			void walk.then((state) => {
				ended = state;
				control?.agentEnded();
			});
			// A person who drives when the agent finished goes on until they hand back.
			while ((!ended || control?.holding) && !stopped.aborted) {
				await Promise.race([sleep(pollMs, stopped), ...(ended ? [] : [walk])]);
				await control?.follow();
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
		// Nobody drives while the visit records where it ended.
		await control?.end();
		// The page the walk ended on is a step of its own, whatever the quiet period,
		// also when the walk ended right after opening a tab puppeteer has no page for yet.
		await visitorTabs.settled(FINAL_TAB_WAIT_MS);
		await recordStep(true);
		await downloads.settled();
		announceDownloads();
		return {
			startedAt,
			steps,
			requests: network.snapshot(),
			downloads: downloads.files(),
			downloadFailures: downloads.failures(),
			clipboardWrites: params.clipboard.writes(),
			agent: agentOutcome,
		};
	} finally {
		clock.clear();
		await control?.end();
	}
}

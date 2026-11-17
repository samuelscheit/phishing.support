import type { Browser, CDPSession, Page } from "rebrowser-puppeteer-core";

import { errorText } from "../error_text";
import { ExfiltrationNetworkRecorder } from "../exfiltration/recorder";
import type { CapturedNetworkRequest, ExfiltrationCanaries } from "../exfiltration/types";
import { interceptDownloads, type DownloadedFile, type DownloadInterceptor, type FailedDownload } from "../website_download";
import type { VisitAgent, VisitAgentAction } from "./agent";
import { buildSiteVisitTask, visitAgentReport, VISIT_BUDGET_MS, type VisitAgentReport } from "./task";

/**
 * One visit of a reported site, the way its victim goes through it: the
 * capture has loaded the page, then an agent walks the site in that same
 * browser and tab, entering only synthetic values, while the visit records
 * what the evidence needs: each page it reaches, every request (where the
 * synthetic values go), and every file it downloads. The agent only moves;
 * what it reports about itself is never evidence.
 */

/** Pages recorded per visit beyond the first; a site that changes forever cannot hold it open. */
const MAX_STEPS = 12;
const POLL_MS = 1_000;
const AGENT_POLL_MS = 2_000;
const ACTIONS_POLL_MS = 4_000;
/** A page change is recorded once the page has stayed the same this long. */
const STEP_QUIET_MS = 2_000;
/** Screencast frames published per second at most. */
const LIVE_FRAMES_PER_SECOND = 3;

/** What a visit shows while it runs: the tab's screen, each recorded page, and the agent's actions. */
export type SiteVisitLiveEvent =
	| { type: "browser.frame"; jpeg: string; url: string }
	| { type: "browser.step"; index: number; url: string; title: string }
	| { type: "browser.action"; kind: string; text: string }
	| { type: "browser.download"; fileName: string; url: string };

export type SiteVisitAgentOutcome = {
	runId?: string;
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
	/** Record the page as it stands as the visit's next step. */
	snapshot: () => Promise<Step>;
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
	cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
		void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
		const now = Date.now();
		if (now - last < 1_000 / LIVE_FRAMES_PER_SECOND) return;
		last = now;
		live({ type: "browser.frame", jpeg: frame.data, url: page.url() });
	});
	await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: 960, maxHeight: 720, everyNthFrame: 2 });
	return () => cdp.send("Page.stopScreencast").then(() => undefined, () => undefined);
}

/** Runs in the page: what a person reads on the element a selector names (its label, text, placeholder, or name). */
function elementCaption(selector: string): string | null {
	let element: Element | null;
	try {
		element = document.querySelector(selector);
	} catch {
		return null;
	}
	if (!element) return null;
	const compact = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim().slice(0, 80) || null;
	const id = element.getAttribute("id");
	const label = (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null) ?? element.closest("label");
	return compact(label?.textContent)
		?? compact(element.getAttribute("aria-label"))
		?? compact((element as HTMLElement).innerText)
		?? compact(element.getAttribute("placeholder"))
		?? compact(element.getAttribute("value"))
		?? compact(element.getAttribute("title"))
		?? compact(element.getAttribute("name"));
}

/** The action as a person reads it: its element's caption added to a bare verb (`Clicked "Download"`). */
async function described(page: Page, action: VisitAgentAction): Promise<VisitAgentAction> {
	if (!action.selector) return action;
	const caption = await page.evaluate(elementCaption, action.selector).catch(() => null);
	return caption ? { ...action, text: `${action.text} ${JSON.stringify(caption)}` } : action;
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
	const cdp = await page.target().createCDPSession();
	let downloads: DownloadInterceptor | undefined;
	let stopScreencast: (() => Promise<void>) | undefined;
	const steps: SiteVisitRecording<Step>["steps"] = [];
	const actions: VisitAgentAction[] = [];
	const agentOutcome: SiteVisitAgentOutcome = { outcome: "failed", actions };
	try {
		downloads = await interceptDownloads(page, cdp, params.userAgent);
		stopScreencast = await startScreencast(cdp, page, live).catch(() => undefined);

		let recorded = await pageState(page);
		let pending: { url: string; text: string; since: number } | undefined;
		let announcedDownloads = 0;
		/** Record the page once it has changed and then stayed the same for the quiet period. */
		const recordStep = async (force = false) => {
			if (steps.length >= MAX_STEPS) return;
			const state = await pageState(page);
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
			const step = await params.snapshot();
			steps.push({ step, observedAt: new Date() });
			live({ type: "browser.step", index: steps.length, url: state.url, title: state.title });
		};
		const announceDownloads = () => {
			for (const file of downloads!.files().slice(announcedDownloads)) live({ type: "browser.download", fileName: file.fileName, url: file.url });
			announcedDownloads = downloads!.files().length;
		};

		let runId: string | undefined;
		try {
			({ runId } = await agent.start(buildSiteVisitTask(params.url, params.canaries, undefined, undefined, params.instructions), params.agentAddress));
			agentOutcome.runId = runId;
		} catch (error) {
			agentOutcome.failure = `The visiting agent could not start: ${errorText(error).slice(0, 300)}`;
		}

		let nextAgentPoll = 0;
		let nextActionsPoll = 0;
		while (runId && !stopped.aborted) {
			await sleep(pollMs, stopped);
			if (stopped.aborted) break;
			await recordStep();
			announceDownloads();
			const now = Date.now();
			if (now >= nextActionsPoll) {
				nextActionsPoll = now + ACTIONS_POLL_MS;
				const known = new Set(actions.map((action) => action.id));
				for (const action of await agent.actions(runId).catch(() => [])) {
					if (known.has(action.id)) continue;
					const read = await described(page, { ...action, at: action.at ?? new Date().toISOString() });
					actions.push(read);
					live({ type: "browser.action", kind: read.kind, text: read.text });
				}
			}
			if (now < nextAgentPoll) continue;
			nextAgentPoll = now + AGENT_POLL_MS;
			const state = await agent.state(runId).catch((error: unknown) => ({ state: "failed" as const, reason: errorText(error).slice(0, 300) }));
			if (state.state === "running") continue;
			if (state.state === "completed") {
				agentOutcome.outcome = "completed";
				const report = visitAgentReport(state.output);
				if (report) agentOutcome.report = report;
			} else {
				agentOutcome.failure = state.reason;
			}
			break;
		}
		if (runId && stopped.aborted && !agentOutcome.failure && agentOutcome.outcome !== "completed") {
			agentOutcome.outcome = "timed_out";
			agentOutcome.failure = budget.aborted ? `The visit's ${Math.round((params.budgetMs ?? VISIT_BUDGET_MS) / 60_000)}-minute budget ended the walk.` : "The visit was canceled.";
			await agent.cancel(runId).catch(() => undefined);
		}
		if (runId) {
			const known = new Set(actions.map((action) => action.id));
			for (const action of await agent.actions(runId).catch(() => [])) if (!known.has(action.id)) actions.push(await described(page, { ...action, at: action.at ?? new Date().toISOString() }));
		}
		// The page the walk ended on is a step of its own, whatever the quiet period.
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
		await stopScreencast?.();
		await cdp.send("Fetch.disable").catch(() => undefined);
		await cdp.detach().catch(() => undefined);
	}
}

import type { SiteVisitOptions, SiteWalk, WebsiteArchiveResult } from "../website/archive/types";
import type { visitSite } from "../website/archive/visit_site";
import type { DownloadedFile } from "../website/visit/download";
import type { ClipboardWrite } from "../browser/clipboard";
import type { CapturedNetworkRequest, ExfiltrationCanaries } from "../exfiltration/types";
import type { SiteVisitRecording } from "./visit";

/**
 * What a scripted visit does, for tests that drive the analysis without a
 * browser: the pages the agent reaches, the requests the site sends (built
 * from the visit's own synthetic values), the files it downloads, and what
 * its pages copy.
 */
export type ScriptedVisit = {
	steps?: WebsiteArchiveResult[];
	requests?: (canaries: ExfiltrationCanaries) => CapturedNetworkRequest[];
	downloads?: Array<Omit<DownloadedFile, "observedAt">>;
	/** Each while the last page is shown unless it carries its own time. */
	clipboardWrites?: Array<Omit<ClipboardWrite, "at"> & { at?: string }>;
	agent?: Partial<SiteVisitRecording<unknown>["agent"]>;
	/** The walk breaks off with this error (a broken browser). */
	error?: Error;
};

/** A first page a scripted visit loads, with the walk it plays when the visit walks on, and what happens when its browser closes. */
export type ScriptedPage = WebsiteArchiveResult & { walk?: ScriptedVisit; onClose?: () => void };

/**
 * The walk `script` plays: the first page is shown first, each step a second
 * apart, every request, download and clipboard write while the last page is
 * shown unless it carries its own timestamp.
 */
export function playScript(script: ScriptedVisit, walk: Pick<SiteWalk, "canaries">): SiteVisitRecording<WebsiteArchiveResult> {
	if (script.error) throw script.error;
	const startedAt = new Date("2026-11-15T10:00:00.000Z");
	const at = (seconds: number) => new Date(startedAt.getTime() + seconds * 1_000);
	const steps = script.steps ?? [];
	const lastShown = at(steps.length + 0.5);
	return {
		startedAt,
		steps: steps.map((step, index) => ({ step, observedAt: at(index + 1) })),
		requests: (script.requests?.(walk.canaries) ?? []).map((request) => ({ ...request, timestamp: request.timestamp || lastShown.toISOString() })),
		downloads: (script.downloads ?? []).map((file) => ({ ...file, observedAt: lastShown })),
		downloadFailures: [],
		clipboardWrites: (script.clipboardWrites ?? []).map((write) => ({ ...write, at: write.at ?? lastShown.toISOString() })),
		agent: { outcome: "completed", actions: [], report: { asksForPhone: false, blockedByChallenge: false, stoppedReason: "The flow ended." }, ...script.agent },
	};
}

/**
 * A browser visit without a browser, keeping `visitSite`'s contract: `load`
 * answers each visit's first page, which goes to the visit's `walk`
 * decision; a decoy (unresolved cloaking) is never walked, a walk plays the
 * page's script, and the "browser" closes whatever happened. Every visit's
 * options go to `calls`, every walk's parameters to `walks`.
 */
export function scriptedSiteVisit(load: (options: SiteVisitOptions) => ScriptedPage | Promise<ScriptedPage>, record: { calls?: SiteVisitOptions[]; walks?: SiteWalk[] } = {}): typeof visitSite {
	return async (options) => {
		record.calls?.push(options);
		const { walk: script, onClose, ...initial } = await load(options);
		try {
			const walk = await options.walk?.(initial);
			if (!walk || initial.cloaking?.outcome === "unresolved") return { initial };
			record.walks?.push(walk);
			return { initial, recording: playScript(script ?? {}, walk) };
		} finally {
			onClose?.();
		}
	};
}

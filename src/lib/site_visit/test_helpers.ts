import type { WebsiteArchiveResult, WebsitePageSession, WebsiteVisitParams } from "../website/archive/types";
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
};

/**
 * A capture session whose visit plays `script`: the captured page is shown
 * first, each step a second apart, every request, download and clipboard
 * write while the last page is shown unless it carries its own timestamp.
 */
export function scriptedVisitSession(script: ScriptedVisit = {}, visits: WebsiteVisitParams[] = []): WebsitePageSession {
	return {
		visit: async (params) => {
			visits.push(params);
			const startedAt = new Date("2026-11-15T10:00:00.000Z");
			const at = (seconds: number) => new Date(startedAt.getTime() + seconds * 1_000);
			const steps = script.steps ?? [];
			const lastShown = at(steps.length + 0.5);
			const recording: SiteVisitRecording<WebsiteArchiveResult> = {
				startedAt,
				steps: steps.map((step, index) => ({ step, observedAt: at(index + 1) })),
				requests: (script.requests?.(params.canaries) ?? []).map((request) => ({ ...request, timestamp: request.timestamp || lastShown.toISOString() })),
				downloads: (script.downloads ?? []).map((file) => ({ ...file, observedAt: lastShown })),
				downloadFailures: [],
				clipboardWrites: (script.clipboardWrites ?? []).map((write) => ({ ...write, at: write.at ?? lastShown.toISOString() })),
				agent: { outcome: "completed", actions: [], report: { asksForPhone: false, blockedByChallenge: false, stoppedReason: "The flow ended." }, ...script.agent },
			};
			return recording;
		},
		close: async () => undefined,
	};
}

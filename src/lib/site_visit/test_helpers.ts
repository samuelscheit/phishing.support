import type { WebsiteArchiveResult, WebsitePageSession, WebsiteVisitParams } from "../website_archive";
import type { DownloadedFile } from "../website_download";
import type { CapturedNetworkRequest, ExfiltrationCanaries } from "../exfiltration/types";
import type { SiteVisitAgentOutcome, SiteVisitRecording } from "./visit";

/**
 * What a scripted visit does, for tests that drive the analysis without a
 * browser: the pages the agent reaches, the requests the site sends (built
 * from the visit's own synthetic values), and the files it downloads.
 */
export type ScriptedVisit = {
	steps?: WebsiteArchiveResult[];
	requests?: (canaries: ExfiltrationCanaries) => CapturedNetworkRequest[];
	downloads?: Array<Omit<DownloadedFile, "observedAt">>;
	agent?: Partial<SiteVisitAgentOutcome>;
};

/**
 * A capture session whose visit plays `script`: the captured page is shown
 * first, each step a second apart, every request and download while the
 * last page is shown unless it carries its own timestamp.
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
				agent: { runId: "tsk_v2_scripted", outcome: "completed", actions: [], report: { submissionsAttempted: 0, downloadsStarted: 0, asksForPhone: false, stoppedReason: "The flow ended." }, ...script.agent },
			};
			return recording;
		},
		close: async () => undefined,
	};
}

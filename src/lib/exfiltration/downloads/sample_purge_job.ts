import { downloadPipelineConfigFromEnvironment } from "./pipeline";
import { purgeExpiredSamples, type PurgeResult } from "./sample_purge";

/** How often the purge runs. Retention is measured in days, so an hourly pass is ample. */
export const SAMPLE_PURGE_INTERVAL_MS = 60 * 60_000;

/**
 * Run one purge pass with the configured store root and retention. With no store
 * configured there is nothing to delete, and the pass returns without touching disk.
 */
export async function runSamplePurge(now: Date = new Date()): Promise<PurgeResult> {
	const config = downloadPipelineConfigFromEnvironment();
	if (!config.storeRoot) return { removed: 0, kept: 0, skipped: 0 };
	return purgeExpiredSamples({ root: config.storeRoot, now, retentionMs: config.retentionMs });
}

/**
 * Start a recurring purge owned by the caller. A pass that fails is reported through
 * `onError` and never stops the schedule, so one bad file cannot disable retention.
 * The returned function stops the schedule and waits for no pass in flight to finish
 * writing, because each pass only removes whole files.
 */
export function startSamplePurgeSchedule(options: {
	intervalMs?: number;
	run?: () => Promise<PurgeResult>;
	onError?: (error: unknown) => void;
} = {}): () => void {
	const run = options.run ?? (() => runSamplePurge());
	const onError = options.onError ?? ((error: unknown) => console.error("Sample purge failed:", error));
	let stopped = false;
	const tick = async () => {
		if (stopped) return;
		try {
			await run();
		} catch (error) {
			onError(error);
		}
	};
	const timer = setInterval(() => { void tick(); }, options.intervalMs ?? SAMPLE_PURGE_INTERVAL_MS);
	timer.unref?.();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

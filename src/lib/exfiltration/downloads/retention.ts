/**
 * Retention for stored malware samples. Pure decisions over timestamps, so the
 * TTL boundary is testable without a clock or a filesystem.
 */

/** How long a sample archive may stay on disk. Operators may shorten it, never lengthen it past the ceiling. */
export const DEFAULT_SAMPLE_RETENTION_DAYS = 30;
export const MAX_SAMPLE_RETENTION_DAYS = 90;

export function sampleRetentionMs(value: string | undefined): number {
	const trimmed = value?.trim();
	if (!trimmed) return DEFAULT_SAMPLE_RETENTION_DAYS * 86_400_000;
	if (!/^\d+$/.test(trimmed)) throw new Error("SAMPLE_RETENTION_DAYS must be a whole number of days.");
	const days = Number(trimmed);
	if (days < 1 || days > MAX_SAMPLE_RETENTION_DAYS) throw new Error(`SAMPLE_RETENTION_DAYS must be from 1 to ${MAX_SAMPLE_RETENTION_DAYS}.`);
	return days * 86_400_000;
}

/** A sample is expired once its retention window has fully elapsed; the boundary instant is still retained. */
export function isSampleExpired(storedAt: Date, now: Date, retentionMs: number): boolean {
	if (!Number.isFinite(storedAt.getTime()) || !Number.isFinite(now.getTime())) return true;
	return now.getTime() - storedAt.getTime() > retentionMs;
}

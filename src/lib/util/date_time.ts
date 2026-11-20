export type DateTimeValue = Date | string | number | null | undefined;

/**
 * Produces a timezone-independent timestamp for content rendered on both the
 * server and the client. Browser-local date formatting causes React hydration
 * to diverge whenever the server and viewer are in different timezones.
 */
export function formatUtcDateTime(value: DateTimeValue): string | undefined {
	if (value === null || value === undefined) return undefined;

	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;

	return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** Milliseconds per unit, so a duration reads as `30 * DAY_MS` rather than `30 * 24 * 60 * 60_000`. */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

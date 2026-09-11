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

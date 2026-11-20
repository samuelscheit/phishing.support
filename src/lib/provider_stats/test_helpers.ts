/** A moment `hours` after 2026-01-01 UTC, so a test reads its timeline as plain numbers. */
export const at = (hours: number) => new Date(Date.UTC(2026, 0, 1) + hours * 3_600_000);

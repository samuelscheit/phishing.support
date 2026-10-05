/** Count search inputs without retaining their potentially sensitive text. */
export function countSearchQueries(value: unknown, max = 24, depth = 0): number {
	if (depth > 3) return 0;
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.min(max, Math.floor(value)));
	if (typeof value === "string") return value.trim() ? 1 : 0;
	if (Array.isArray(value))
		return Math.min(
			max,
			value.reduce((total, item) => total + countSearchQueries(item, max, depth + 1), 0),
		);
	if (!value || typeof value !== "object") return 0;
	const object = value as Record<string, unknown>;
	return Math.min(
		max,
		["query", "queries", "search_query", "search_queries", "q"].reduce(
			(total, key) => total + (key in object ? countSearchQueries(object[key], max, depth + 1) : 0),
			0,
		),
	);
}

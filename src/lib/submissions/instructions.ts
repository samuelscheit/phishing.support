/**
 * Free text the reporter of a website adds to the case: how the visiting
 * browser agent should drive the site (`browser`) and what the analysis should
 * look at or know (`analysis`). Both are optional and kept in the case record.
 */
export type ReporterInstructions = { browser?: string; analysis?: string };

export const REPORTER_INSTRUCTION_FIELDS = ["browser", "analysis"] as const;

/** Most characters of one instruction, after trimming. */
export const MAX_REPORTER_INSTRUCTION_CHARS = 2_000;

export type ParsedReporterInstructions = { ok: true; instructions?: ReporterInstructions } | { ok: false; error: string };

/**
 * The reporter's instructions from a request body's `instructions`: each field
 * trimmed, blank ones dropped; `instructions` is absent when none is left.
 */
export function parseReporterInstructions(value: unknown): ParsedReporterInstructions {
	if (value === undefined || value === null) return { ok: true };
	if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "instructions must be an object with optional browser and analysis text" };
	const instructions: ReporterInstructions = {};
	for (const field of REPORTER_INSTRUCTION_FIELDS) {
		const text = (value as Record<string, unknown>)[field];
		if (text === undefined || text === null) continue;
		if (typeof text !== "string") return { ok: false, error: `instructions.${field} must be text` };
		const trimmed = text.trim();
		if (trimmed.length > MAX_REPORTER_INSTRUCTION_CHARS) return { ok: false, error: `instructions.${field} is longer than ${MAX_REPORTER_INSTRUCTION_CHARS} characters` };
		if (trimmed) instructions[field] = trimmed;
	}
	return instructions.browser || instructions.analysis ? { ok: true, instructions } : { ok: true };
}

import type { SubmissionStatus } from "@/lib/db/schema";

/**
 * The status chips of the public submission list. Each one stands for the
 * statuses it groups; every status belongs to exactly one chip.
 */
export const SUBMISSION_FILTERS = {
	/** Waiting in the visit queue or being analyzed now. */
	running: ["queued", "running"],
	reported: ["reported"],
	no_threat: ["invalid"],
	failed: ["failed"],
} as const satisfies Record<string, readonly SubmissionStatus[]>;

export type SubmissionFilter = keyof typeof SUBMISSION_FILTERS;

export const SUBMISSION_FILTER_NAMES = Object.keys(SUBMISSION_FILTERS) as SubmissionFilter[];

/** What the list shows until the reader picks otherwise: what is being analyzed now, and what was confirmed. */
export const DEFAULT_SUBMISSION_FILTERS: readonly SubmissionFilter[] = ["running", "reported"];

export function isSubmissionFilter(value: unknown): value is SubmissionFilter {
	return typeof value === "string" && Object.hasOwn(SUBMISSION_FILTERS, value);
}

export class SubmissionFilterError extends Error {
	constructor(value: string) {
		super(`Unknown submission filter "${value}"; use ${SUBMISSION_FILTER_NAMES.join(", ")}.`);
		this.name = "SubmissionFilterError";
	}
}

/** `running,phishing` → the chips; an empty value selects none. */
export function parseSubmissionFilters(value: string): SubmissionFilter[] {
	const names = value.split(",").map((name) => name.trim()).filter(Boolean);
	for (const name of names) if (!isSubmissionFilter(name)) throw new SubmissionFilterError(name);
	return [...new Set(names as SubmissionFilter[])];
}

/** The chip a status is counted under. */
export function submissionFilterOf(status: SubmissionStatus): SubmissionFilter {
	return SUBMISSION_FILTER_NAMES.find((name) => (SUBMISSION_FILTERS[name] as readonly SubmissionStatus[]).includes(status))!;
}

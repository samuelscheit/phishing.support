import type { AnalysisEntryStatus, AnalysisTimelineEntry } from "./analysis_stream_events";

/**
 * The compact activity model shown to readers.  A single model response can
 * emit dozens of low-level packets, so repeated notes and searches are
 * combined into one useful update rather than displayed as a wall of events.
 */
export type ReaderTimelineEntry =
	| {
			kind: "step";
			id: string;
			step: string;
			progress: number | null;
			status: AnalysisEntryStatus;
	  }
	| {
			kind: "reasoning";
			id: string;
			title: string;
			text: string;
			earlierTexts: string[];
			status: AnalysisEntryStatus;
	  }
	| {
			kind: "tool";
			id: string;
			toolType: string;
			title: string;
			phase: string;
			status: AnalysisEntryStatus;
			queryCount: number;
	  }
	| {
			kind: "notice";
			id: string;
			title: string;
			detail?: string;
			status: AnalysisEntryStatus;
	  };

const MAX_VISIBLE_REASONING_NOTES = 8;

function friendlyToolTitle(toolType: string, status: AnalysisEntryStatus): string {
	if (toolType.includes("web_search")) {
		if (status === "complete") return "Related information checked";
		if (status === "failed") return "Related information could not be checked";
		return "Checking related information";
	}
	if (toolType.includes("file_search")) return status === "complete" ? "Related files checked" : "Checking related files";
	if (toolType.includes("code_interpreter")) return status === "complete" ? "Data checked" : "Checking the data";
	if (toolType.includes("computer")) return status === "complete" ? "Page reviewed" : "Reviewing the page";
	if (toolType.includes("image")) return status === "complete" ? "Image reviewed" : "Reviewing an image";
	if (toolType.includes("mcp")) return status === "complete" ? "External information checked" : "Checking an external source";
	return "Additional check";
}

function friendlyToolPhase(phase: string): string {
	const normalized = phase.toLowerCase();
	if (normalized === "done" || normalized === "completed") return "Finished";
	if (normalized === "searching") return "Looking for related information";
	if (normalized === "starting" || normalized === "in progress" || normalized === "in_progress") return "Working";
	if (normalized === "failed") return "Could not finish this check";
	if (normalized === "incomplete") return "Partially finished";
	return phase;
}

function mergeStatus(previous: AnalysisEntryStatus, next: AnalysisEntryStatus): AnalysisEntryStatus {
	if (next === "failed") return "failed";
	if (next === "warning") return "warning";
	if (next === "active") return "active";
	if (next === "pending" && previous === "pending") return "pending";
	return next;
}

function addUnique(values: string[], additions: readonly string[]): string[] {
	const next = values.slice();
	for (const value of additions) {
		if (value && !next.includes(value)) next.push(value);
	}
	return next;
}

/**
 * Collapse protocol-level timeline entries into a short, reader-friendly
 * activity list.  Ordering follows the first occurrence of each activity.
 */
export function summarizeAnalysisEntries(entries: readonly AnalysisTimelineEntry[]): ReaderTimelineEntry[] {
	const result: ReaderTimelineEntry[] = [];
	const reasoningIndex = new Map<string, number>();
	const toolIndex = new Map<string, number>();

	for (const entry of entries) {
		if (entry.kind === "step") {
			result.push({ kind: "step", id: entry.id, step: entry.step, progress: entry.progress, status: entry.status });
			continue;
		}

		if (entry.kind === "reasoning") {
			const existingIndex = reasoningIndex.get("reasoning");
			if (existingIndex === undefined) {
				reasoningIndex.set("reasoning", result.length);
				result.push({
					kind: "reasoning",
					id: "reader:reasoning",
					title: "Reviewing the evidence",
					text: entry.text,
					earlierTexts: [],
					status: entry.status,
				});
			} else {
				const current = result[existingIndex];
				if (current?.kind !== "reasoning") continue;
				const earlierTexts =
					current.text && current.text !== entry.text
						? addUnique(current.earlierTexts, [current.text]).slice(-MAX_VISIBLE_REASONING_NOTES)
						: current.earlierTexts;
				result[existingIndex] = {
					...current,
					text: entry.text,
					earlierTexts,
					status: mergeStatus(current.status, entry.status),
				};
			}
			continue;
		}

		if (entry.kind === "tool") {
			const groupKey = entry.toolType;
			const existingIndex = toolIndex.get(groupKey);
			if (existingIndex === undefined) {
				toolIndex.set(groupKey, result.length);
				result.push({
					kind: "tool",
					id: `reader:tool:${groupKey}`,
					toolType: groupKey,
					title: friendlyToolTitle(entry.toolType, entry.status),
					phase: friendlyToolPhase(entry.phase),
					status: entry.status,
					queryCount: entry.queryCount,
				});
			} else {
				const current = result[existingIndex];
				if (current?.kind !== "tool") continue;
				result[existingIndex] = {
					...current,
					title: friendlyToolTitle(entry.toolType, mergeStatus(current.status, entry.status)),
					phase: friendlyToolPhase(entry.phase),
					status: mergeStatus(current.status, entry.status),
					queryCount: current.queryCount + entry.queryCount,
				};
			}
			continue;
		}

		if (entry.status === "failed" || entry.status === "warning") {
			result.push({ kind: "notice", id: entry.id, title: entry.title, detail: entry.detail, status: entry.status });
		}
	}

	// Once a later pipeline step appears, earlier steps are finished.  The
	// provider only reports progress for the current step, so leaving every
	// historical step marked "In progress" is confusing to readers.
	const stepIndexes = result.reduce<number[]>((indexes, entry, index) => {
		if (entry.kind === "step") indexes.push(index);
		return indexes;
	}, []);
	const latestStepIndex = stepIndexes.at(-1);
	if (latestStepIndex !== undefined) {
		for (const index of stepIndexes) {
			if (index >= latestStepIndex) continue;
			const step = result[index];
			if (step?.kind === "step" && step.status === "active") result[index] = { ...step, status: "complete" };
		}
	}

	return result;
}

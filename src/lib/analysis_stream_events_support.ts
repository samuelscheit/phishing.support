/** Shared, browser-safe helpers for the analysis event reducer. */

import { countSearchQueries } from "./analysis_stream_query_count";

export type AnalysisStreamEvent = Readonly<Record<string, unknown>>;

export type AnalysisEntryStatus = "pending" | "active" | "complete" | "failed" | "warning";

/** Only the information needed to explain progress to a reader is retained. */
export type AnalysisTimelineEntry =
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
			text: string;
			status: AnalysisEntryStatus;
	  }
	| {
			kind: "tool";
			id: string;
			toolType: string;
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

export type AnalysisRunStatus = "idle" | "created" | "running" | "retrying" | "completed" | "failed" | "incomplete";
export type AnalysisConnectionStatus = "connecting" | "connected" | "closed" | "error";

export type AnalysisStreamState = {
	connection: AnalysisConnectionStatus;
	runStatus: AnalysisRunStatus;
	/** A submission-level classification/reporting pass may still be running. */
	progressExpected: boolean;
	error: string | null;
	step: { name: string; progress: number | null } | null;
	outputText: string;
	refusalText: string;
	entries: AnalysisTimelineEntry[];
	/** Sequence/lifecycle keys used to ignore replayed events after reconnects. */
	processedEventKeys: string[];
};

export const MAX_ENTRIES = 500;
export const MAX_PROCESSED_KEYS = 1_024;
export const MAX_REASONING_TEXT = 1_000;
export const MAX_OUTPUT_TEXT = 160_000;

export const TOOL_PHASES = new Set(["in_progress", "searching", "interpreting", "generating", "completed", "failed", "incomplete", "done"]);

export const TOOL_ITEM_TYPES = new Set([
	"web_search_call",
	"file_search_call",
	"code_interpreter_call",
	"computer_call",
	"function_call",
	"function_shell_call",
	"image_gen_call",
	"image_generation_call",
	"mcp_call",
	"mcp_list_tools",
	"custom_tool_call",
	"tool_search_call",
	"tool_search_output",
]);

export function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function stringValue(value: unknown): string | null {
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bounded(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

export function boundedText(value: unknown, max: number): string | null {
	const text = stringValue(value);
	return text ? bounded(text, max) : null;
}

function humanize(value: string): string {
	return value
		.replace(/^response\./, "")
		.replace(/[._-]+/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase())
		.trim();
}

/** Translate internal pipeline step names into labels a reader can scan. */
export function humanizeAnalysisStep(value: string): string {
	const normalized = value.trim().toLowerCase();
	const labels: Record<string, string> = {
		start: "Starting checks",
		whois_lookup: "Checking domain details",
		analysis_run: "Reviewing the submission",
		website_capture: "Capturing the website",
		website_archive: "Capturing the website",
		archive_website: "Capturing website evidence",
		save_artifacts: "Saving website evidence",
		website_analysis: "Checking the website",
		email_analysis: "Checking the email",
		classification: "Assessing risk",
		structured_response: "Confirming the result",
		resolution: "Finding the right contacts",
		reporting: "Preparing reports",
		completed: "Finished",
		failed: "Stopped",
	};
	return labels[normalized] ?? humanize(value);
}

export function phaseLabel(phase: string): string {
	const labels: Record<string, string> = {
		pending: "Queued",
		in_progress: "Starting",
		searching: "Searching",
		interpreting: "Reviewing",
		generating: "Preparing",
		completed: "Done",
		incomplete: "Partially finished",
		failed: "Could not finish",
		done: "Done",
	};
	return labels[phase] ?? "Working";
}

export function eventTypeOf(event: AnalysisStreamEvent): string | null {
	return stringValue(event.type);
}

export function statusFromPhase(phase: string | null | undefined): AnalysisEntryStatus {
	if (phase === "completed" || phase === "done") return "complete";
	if (phase === "failed") return "failed";
	if (phase === "incomplete") return "warning";
	return phase === "pending" ? "pending" : "active";
}

export function sequenceOf(event: AnalysisStreamEvent): number | undefined {
	const sequence = numberValue(event.sequence_number);
	return sequence === null ? undefined : sequence;
}

export function upsertEntry(
	entries: AnalysisTimelineEntry[],
	id: string,
	create: () => AnalysisTimelineEntry,
	update: (entry: AnalysisTimelineEntry) => AnalysisTimelineEntry,
): AnalysisTimelineEntry[] {
	const index = entries.findIndex((entry) => entry.id === id);
	if (index < 0) return [...entries, create()].slice(-MAX_ENTRIES);
	const next = entries.slice();
	next[index] = update(next[index]!);
	return next;
}

export function noticeEntry(
	id: string,
	title: string,
	status: AnalysisEntryStatus,
	detail?: string,
): Extract<AnalysisTimelineEntry, { kind: "notice" }> {
	return { kind: "notice", id, title, status, ...(detail ? { detail } : {}) };
}

export function outputItem(event: AnalysisStreamEvent): Record<string, unknown> | null {
	return record(event.item);
}

export function itemIdOf(item: Record<string, unknown> | null): string | null {
	return item ? stringValue(item.id) : null;
}

export function itemTypeOf(item: Record<string, unknown> | null): string | null {
	return item ? stringValue(item.type) : null;
}

export function isToolItemType(type: string | null): boolean {
	if (!type) return false;
	return TOOL_ITEM_TYPES.has(type) || type.endsWith("_call") || type.endsWith("_output");
}

export function toolEventParts(eventType: string): { toolType: string; phase: string } | null {
	const match = /^response\.([^.]+)\.([^.]+)$/.exec(eventType);
	if (!match || !TOOL_PHASES.has(match[2]!)) return null;
	const toolType = match[1]!;
	if (!isToolItemType(toolType)) return null;
	return { toolType, phase: match[2]! };
}

export function toolDetails(item: Record<string, unknown> | null): { queryCount: number } {
	if (!item) return { queryCount: 0 };
	const action = record(item.action);
	let queryCount = Math.max(
		countSearchQueries(action?.queries),
		countSearchQueries(action?.query),
		countSearchQueries(action?.query_count),
	);
	const itemType = itemTypeOf(item);
	// Search arguments are useful for a count, but arbitrary tool arguments may
	// contain credentials or submitted personal information, so never expose them.
	if (itemType === "web_search_call" || itemType === "file_search_call")
		queryCount = Math.max(queryCount, countSearchQueries(item.arguments));
	queryCount = Math.max(queryCount, countSearchQueries(item.query), countSearchQueries(item.query_count));
	return { queryCount };
}

export function toolEntryFromItem(
	id: string,
	item: Record<string, unknown> | null,
	phaseOverride?: string,
): Extract<AnalysisTimelineEntry, { kind: "tool" }> {
	const toolType = itemTypeOf(item) ?? "tool_call";
	const phase = phaseOverride ?? stringValue(item?.status) ?? "pending";
	return {
		kind: "tool",
		id,
		toolType,
		phase: phaseLabel(phase),
		status: statusFromPhase(phase),
		queryCount: toolDetails(item).queryCount,
	};
}

export function toolEntryId(toolType: string, itemId: string | null, outputIndex: number | null): string {
	return itemId ? `tool:${itemId}` : `tool:${toolType}:${outputIndex ?? "unknown"}`;
}

export function reasoningEntryId(event: AnalysisStreamEvent): string {
	const itemId = stringValue(event.item_id) ?? "response";
	const summaryIndex = numberValue(event.summary_index) ?? numberValue(event.content_index) ?? 0;
	return `reasoning:${itemId}:${summaryIndex}`;
}

export function reasoningTextFromItem(item: Record<string, unknown> | null): Array<{ text: string; summaryIndex: number }> {
	const summary = item?.summary;
	if (!Array.isArray(summary)) return [];
	const result: Array<{ text: string; summaryIndex: number }> = [];
	for (let index = 0; index < summary.length; index += 1) {
		const part = record(summary[index]);
		const text = boundedText(part?.text, MAX_REASONING_TEXT);
		if (text) result.push({ text, summaryIndex: index });
	}
	return result;
}

export function responseOutputText(value: unknown): string {
	const response = record(value);
	const output = response?.output;
	if (!Array.isArray(output)) return boundedText(response?.output_text, MAX_OUTPUT_TEXT) ?? "";
	const pieces: string[] = [];
	for (const itemValue of output) {
		const item = record(itemValue);
		if (item?.type !== "message" || !Array.isArray(item.content)) continue;
		for (const contentValue of item.content) {
			const content = record(contentValue);
			if (content?.type === "output_text") pieces.push(stringValue(content.text) ?? "");
		}
	}
	return bounded(pieces.join(""), MAX_OUTPUT_TEXT);
}

export function refusalTextFromResponse(value: unknown): string {
	const response = record(value);
	const output = response?.output;
	if (!Array.isArray(output)) return "";
	const pieces: string[] = [];
	for (const itemValue of output) {
		const item = record(itemValue);
		if (item?.type !== "message" || !Array.isArray(item.content)) continue;
		for (const contentValue of item.content) {
			const content = record(contentValue);
			if (content?.type === "refusal") pieces.push(stringValue(content.refusal) ?? "");
		}
	}
	return bounded(pieces.join(""), MAX_OUTPUT_TEXT);
}

export function outputTextFromContentPart(event: AnalysisStreamEvent): string {
	const part = record(event.part);
	return part?.type === "output_text" ? (boundedText(part.text, MAX_OUTPUT_TEXT) ?? "") : "";
}

export function refusalFromContentPart(event: AnalysisStreamEvent): string {
	const part = record(event.part);
	return part?.type === "refusal" ? (boundedText(part.refusal, MAX_OUTPUT_TEXT) ?? "") : "";
}

function eventScope(event: AnalysisStreamEvent): string {
	const responseId = stringValue(record(event.response)?.id);
	const itemId = stringValue(event.item_id) ?? itemIdOf(record(event.item));
	const runId = stringValue(event.runId);
	return responseId ?? itemId ?? runId ?? "";
}

export function eventKey(event: AnalysisStreamEvent, eventType: string): string | null {
	const sequence = sequenceOf(event);
	if (sequence !== undefined) return `sequence:${eventScope(event)}:${eventType}:${sequence}`;
	if (eventType === "analysis.step") {
		return `step:${stringValue(event.step) ?? ""}:${numberValue(event.progress) ?? ""}`;
	}
	if (eventType === "connected") return "connected";
	if (eventType === "run.created" || eventType === "run.started" || eventType === "run.completed" || eventType === "run.failed") {
		return `${eventType}:${stringValue(event.runId) ?? ""}`;
	}
	if (eventType === "run.retrying") return `run.retrying:${numberValue(event.attempt) ?? ""}`;
	return null;
}

export function appendProcessedKey(state: AnalysisStreamState, key: string | null): string[] {
	if (!key) return state.processedEventKeys;
	return [...state.processedEventKeys, key].slice(-MAX_PROCESSED_KEYS);
}

export function mergeOutput(current: string, incoming: string, replace = false): string {
	if (!incoming) return current;
	return bounded(replace ? incoming : `${current}${incoming}`, MAX_OUTPUT_TEXT);
}

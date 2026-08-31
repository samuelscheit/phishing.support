/** Reduce Responses API events into the small activity model shown to readers. */

import type { AnalysisEntryStatus, AnalysisStreamEvent, AnalysisStreamState } from "./analysis_stream_events_support";
import {
	MAX_OUTPUT_TEXT,
	MAX_REASONING_TEXT,
	appendProcessedKey,
	bounded,
	boundedText,
	eventKey,
	eventTypeOf,
	itemIdOf,
	itemTypeOf,
	mergeOutput,
	numberValue,
	noticeEntry,
	outputItem,
	outputTextFromContentPart,
	reasoningEntryId,
	reasoningTextFromItem,
	record,
	refusalFromContentPart,
	refusalTextFromResponse,
	responseOutputText,
	statusFromPhase,
	stringValue,
	toolDetails,
	toolEntryFromItem,
	toolEntryId,
	toolEventParts,
	isToolItemType,
	upsertEntry,
	phaseLabel,
} from "./analysis_stream_events_support";

function updateReasoning(
	state: AnalysisStreamState,
	event: AnalysisStreamEvent,
	eventType: string,
	text: string,
	status: AnalysisEntryStatus,
): AnalysisStreamState {
	if (!text) return state;
	const id = reasoningEntryId(event);
	return {
		...state,
		entries: upsertEntry(
			state.entries,
			id,
			() => ({ kind: "reasoning", id, text: bounded(text, MAX_REASONING_TEXT), status }),
			(entry) => {
				if (entry.kind !== "reasoning") return entry;
				const nextText = eventType.endsWith(".done")
					? bounded(text, MAX_REASONING_TEXT)
					: bounded(`${entry.text}${text}`, MAX_REASONING_TEXT);
				return { ...entry, text: nextText, status };
			},
		),
	};
}

function updateTool(
	state: AnalysisStreamState,
	event: AnalysisStreamEvent,
	toolType: string,
	phase: string,
	item?: Record<string, unknown> | null,
): AnalysisStreamState {
	const itemId = stringValue(event.item_id) ?? itemIdOf(item ?? null);
	const outputIndex = numberValue(event.output_index) ?? numberValue(item?.output_index);
	const id = toolEntryId(toolType, itemId, outputIndex);
	return {
		...state,
		entries: upsertEntry(
			state.entries,
			id,
			() => toolEntryFromItem(id, { ...(item ?? {}), type: itemTypeOf(item ?? null) ?? toolType }, phase),
			(entry) => {
				if (entry.kind !== "tool") return entry;
				const details = toolDetails(item ?? null);
				return {
					...entry,
					phase: phaseLabel(phase),
					status: statusFromPhase(phase),
					queryCount: details.queryCount > 0 ? details.queryCount : entry.queryCount,
				};
			},
		),
	};
}

function applyOutputItem(state: AnalysisStreamState, event: AnalysisStreamEvent, eventType: string): AnalysisStreamState {
	const item = outputItem(event);
	const type = itemTypeOf(item);
	if (type === "reasoning") {
		let next = state;
		for (const summary of reasoningTextFromItem(item)) {
			next = updateReasoning(
				next,
				{ ...event, item_id: itemIdOf(item), summary_index: summary.summaryIndex },
				eventType,
				summary.text,
				"complete",
			);
		}
		return next;
	}
	if (type === "message") {
		const text = responseOutputText({ output: [item] });
		const refusal = refusalTextFromResponse({ output: [item] });
		return {
			...state,
			outputText: mergeOutput(state.outputText, text, Boolean(text)),
			refusalText: mergeOutput(state.refusalText, refusal, Boolean(refusal)),
		};
	}
	if (isToolItemType(type)) {
		const phase = stringValue(item?.status) ?? (eventType.endsWith(".done") ? "completed" : "pending");
		return updateTool(state, event, type!, phase, item);
	}
	return state;
}

function applyResponseLifecycle(state: AnalysisStreamState, event: AnalysisStreamEvent, eventType: string): AnalysisStreamState {
	let runStatus = state.runStatus;
	if (eventType === "response.created" || eventType === "response.queued") {
		// The run lifecycle is emitted before the provider response lifecycle;
		// don't make a visible run jump backwards from "Checking" to "Starting".
		runStatus = state.runStatus === "idle" ? "created" : state.runStatus;
	}
	if (eventType === "response.in_progress") runStatus = "running";
	if (eventType === "response.completed") runStatus = "completed";
	if (eventType === "response.failed") runStatus = "failed";
	if (eventType === "response.incomplete") runStatus = "incomplete";
	const response = event.response;
	return {
		...state,
		runStatus,
		outputText: mergeOutput(state.outputText, responseOutputText(response), eventType === "response.completed"),
		refusalText: mergeOutput(state.refusalText, refusalTextFromResponse(response), eventType === "response.completed"),
	};
}

function applyLifecycle(state: AnalysisStreamState, event: AnalysisStreamEvent, eventType: string): AnalysisStreamState {
	if (eventType === "connected") return { ...state, connection: "connected" };
	if (eventType === "run.created") return { ...state, runStatus: "created" };
	if (eventType === "run.started") return { ...state, runStatus: "running" };
	if (eventType === "run.completed") return { ...state, runStatus: "completed" };
	if (eventType === "run.retrying") {
		const attempt = numberValue(event.attempt);
		const delayMs = numberValue(event.delayMs);
		const detail = delayMs === null ? "We'll try again shortly." : `We'll try again in ${Math.ceil(delayMs / 1_000)}s.`;
		const id = `retry:${attempt ?? "unknown"}`;
		return {
			...state,
			runStatus: "retrying",
			entries: upsertEntry(
				state.entries,
				id,
				() => noticeEntry(id, "Trying again", "warning", detail),
				(entry) => (entry.kind === "notice" ? { ...entry, detail, status: "warning" } : entry),
			),
		};
	}
	if (eventType === "run.failed" || eventType === "error") {
		const error = boundedText(event.error ?? event.message, 800) ?? "The analysis stopped before it could finish.";
		return {
			...state,
			runStatus: "failed",
			error,
			entries: upsertEntry(
				state.entries,
				"run:failed",
				() => noticeEntry("run:failed", "Analysis couldn't finish", "failed", error),
				(entry) => (entry.kind === "notice" ? { ...entry, status: "failed", detail: error } : entry),
			),
		};
	}
	if (eventType === "analysis.step") {
		const step = stringValue(event.step) ?? "Working";
		const progressValue = numberValue(event.progress);
		const progress = progressValue === null ? null : Math.max(0, Math.min(100, progressValue));
		const terminalStep = step.toLowerCase();
		const runStatus =
			terminalStep === "failed" ? "failed" : terminalStep === "completed" || progress === 100 ? "completed" : state.runStatus;
		const stepStatus: AnalysisEntryStatus = terminalStep === "failed" ? "failed" : progress === 100 ? "complete" : "active";
		return {
			...state,
			runStatus,
			...(terminalStep === "failed" ? { error: "The analysis stopped before it could finish." } : {}),
			step: { name: step, progress },
			entries: upsertEntry(
				state.entries,
				`step:${step}`,
				() => ({ kind: "step", id: `step:${step}`, step, progress, status: stepStatus }),
				(entry) => (entry.kind === "step" ? { ...entry, step, progress, status: stepStatus } : entry),
			),
		};
	}
	if (
		eventType.startsWith("response.") &&
		[
			"response.created",
			"response.queued",
			"response.in_progress",
			"response.completed",
			"response.failed",
			"response.incomplete",
		].includes(eventType)
	) {
		return applyResponseLifecycle(state, event, eventType);
	}
	return state;
}

function applyProtocolEvent(state: AnalysisStreamState, event: AnalysisStreamEvent, eventType: string): AnalysisStreamState {
	if (eventType === "response.output_text.delta") {
		return { ...state, outputText: mergeOutput(state.outputText, boundedText(event.delta, MAX_OUTPUT_TEXT) ?? "") };
	}
	if (eventType === "response.output_text.done") {
		return { ...state, outputText: mergeOutput(state.outputText, boundedText(event.text, MAX_OUTPUT_TEXT) ?? "", true) };
	}
	if (eventType === "response.refusal.delta")
		return { ...state, refusalText: mergeOutput(state.refusalText, boundedText(event.delta, MAX_OUTPUT_TEXT) ?? "") };
	if (eventType === "response.refusal.done") {
		return {
			...state,
			refusalText: mergeOutput(
				state.refusalText,
				boundedText(event.refusal, MAX_OUTPUT_TEXT) ?? boundedText(event.text, MAX_OUTPUT_TEXT) ?? "",
				true,
			),
		};
	}
	if (eventType === "response.content_part.done" || eventType === "response.content_part.added") {
		return {
			...state,
			outputText: mergeOutput(state.outputText, outputTextFromContentPart(event), eventType.endsWith(".done")),
			refusalText: mergeOutput(state.refusalText, refusalFromContentPart(event), eventType.endsWith(".done")),
		};
	}
	if (eventType === "response.output_item.added" || eventType === "response.output_item.done")
		return applyOutputItem(state, event, eventType);
	const toolParts = toolEventParts(eventType);
	if (toolParts) return updateTool(state, event, toolParts.toolType, toolParts.phase);
	if (eventType === "response.reasoning_summary_text.delta")
		return updateReasoning(state, event, eventType, boundedText(event.delta, MAX_REASONING_TEXT) ?? "", "active");
	if (eventType === "response.reasoning_summary_text.done")
		return updateReasoning(state, event, eventType, boundedText(event.text, MAX_REASONING_TEXT) ?? "", "complete");
	if (eventType === "response.reasoning_text.delta")
		return updateReasoning(state, event, eventType, boundedText(event.delta, MAX_REASONING_TEXT) ?? "", "active");
	if (eventType === "response.reasoning_text.done")
		return updateReasoning(state, event, eventType, boundedText(event.text, MAX_REASONING_TEXT) ?? "", "complete");
	if (eventType === "response.reasoning_summary_part.added")
		return updateReasoning(state, event, eventType, boundedText(record(event.part)?.text, MAX_REASONING_TEXT) ?? "", "active");
	if (eventType === "response.reasoning_summary_part.done")
		return updateReasoning(state, event, eventType, boundedText(record(event.part)?.text, MAX_REASONING_TEXT) ?? "", "complete");
	return state;
}

export function createInitialAnalysisStreamState(status?: string, progressExpected = false): AnalysisStreamState {
	const normalized = status?.toLowerCase();
	const runStatus: AnalysisStreamState["runStatus"] =
		normalized === "completed"
			? "completed"
			: normalized === "failed"
				? "failed"
				: normalized === "running"
					? "running"
					: ["new", "queued"].includes(normalized ?? "")
						? "created"
						: "idle";
	return {
		connection: "connecting",
		runStatus,
		progressExpected,
		error: null,
		step: null,
		outputText: "",
		refusalText: "",
		entries: [],
		processedEventKeys: [],
	};
}

export function applyAnalysisStreamEvent(state: AnalysisStreamState, event: unknown): AnalysisStreamState {
	const normalized = record(event);
	if (!normalized) return state;
	const eventType = eventTypeOf(normalized);
	if (!eventType) return state;
	const key = eventKey(normalized, eventType);
	if (key && state.processedEventKeys.includes(key)) return state;
	const base: AnalysisStreamState = { ...state, processedEventKeys: appendProcessedKey(state, key) };
	return applyProtocolEvent(applyLifecycle(base, normalized, eventType), normalized, eventType);
}

export function markAnalysisStreamError(
	state: AnalysisStreamState,
	message = "The live analysis stream disconnected.",
): AnalysisStreamState {
	if (["completed", "failed", "incomplete"].includes(state.runStatus) && !state.progressExpected) {
		return { ...state, connection: "closed" };
	}
	return {
		...state,
		connection: "error",
		error: message,
		entries: upsertEntry(
			state.entries,
			"stream:error",
			() => noticeEntry("stream:error", "Live updates stopped", "warning", message),
			(entry) => (entry.kind === "notice" ? { ...entry, status: "warning", detail: message } : entry),
		),
	};
}

export function markAnalysisStreamOpen(state: AnalysisStreamState): AnalysisStreamState {
	return { ...state, connection: "connected", error: null };
}

type OutputContent = { type?: string; text?: string; refusal?: string };
type OutputItem = { type?: string; content?: OutputContent[] };

/** Extract the human-readable assistant response from persisted output items. */
export function extractOutputText(output?: Array<OutputItem>): string | null {
	if (!Array.isArray(output) || output.length === 0) return null;
	const parts: string[] = [];
	for (const item of output) {
		if (item?.type !== "message" || !Array.isArray(item.content)) continue;
		const chunk = item.content
			.map((content) => {
				if (content.type === "output_text") return content.text || "";
				if (content.type === "refusal") return content.refusal ? `Refusal: ${content.refusal}` : "Refusal";
				return "";
			})
			.join("");
		if (chunk.trim()) parts.push(chunk);
	}
	const text = parts.join("\n\n").trim();
	return text || null;
}

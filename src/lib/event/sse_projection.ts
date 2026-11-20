/**
 * Convert an internal analysis event into the small, safe payload the browser
 * needs to show progress and the final result.  The allow-list deliberately
 * excludes encrypted reasoning, headers, request metadata, and arbitrary tool
 * arguments.
 */

import { countSearchQueries } from "../analysis/stream_query_count";
import { asRecord, type JsonRecord, finiteNumber } from "../util/values";

const MAX_TEXT = 8_000;
const MAX_OUTPUT_TEXT = 160_000;
const MAX_LIST = 24;
/** A live screencast frame, base64 JPEG; a frame past this is dropped rather than cut. */
const MAX_BROWSER_FRAME = 600_000;

function asString(value: unknown, max = MAX_TEXT): string | undefined {
	if (typeof value === "bigint") return value.toString();
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function setIfDefined(target: JsonRecord, key: string, value: unknown): void {
	if (value !== undefined) target[key] = value;
}

function projectAction(value: unknown): JsonRecord | undefined {
	const action = asRecord(value);
	if (!action) return undefined;
	const projected: JsonRecord = {};
	const queryCount = Math.max(
		countSearchQueries(action.queries, MAX_LIST),
		countSearchQueries(action.query, MAX_LIST),
		countSearchQueries(action.search_query, MAX_LIST),
	);
	if (queryCount > 0) projected.query_count = queryCount;
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectContent(value: unknown): JsonRecord | undefined {
	const content = asRecord(value);
	if (!content) return undefined;
	const projected: JsonRecord = {};
	setIfDefined(projected, "type", asString(content.type, 100));
	setIfDefined(projected, "text", asString(content.text, MAX_OUTPUT_TEXT));
	setIfDefined(projected, "refusal", asString(content.refusal, MAX_OUTPUT_TEXT));
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectItem(value: unknown): JsonRecord | undefined {
	const item = asRecord(value);
	if (!item) return undefined;
	const projected: JsonRecord = {};
	for (const key of ["id", "type", "status"]) setIfDefined(projected, key, asString(item[key], 300));
	setIfDefined(projected, "action", projectAction(item.action));
	const queryCount = Math.max(
		countSearchQueries(item.queries, MAX_LIST),
		countSearchQueries(item.query, MAX_LIST),
		countSearchQueries(item.query_count, MAX_LIST),
	);
	if (queryCount > 0) projected.query_count = queryCount;
	if (Array.isArray(item.summary)) {
		const summary = item.summary
			.slice(0, MAX_LIST)
			.map(projectContent)
			.filter((part): part is JsonRecord => Boolean(part));
		if (summary.length > 0) projected.summary = summary;
	}
	if (Array.isArray(item.content)) {
		const content = item.content
			.slice(0, MAX_LIST)
			.map(projectContent)
			.filter((part): part is JsonRecord => Boolean(part));
		if (content.length > 0) projected.content = content;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectResponse(value: unknown): JsonRecord | undefined {
	const response = asRecord(value);
	if (!response) return undefined;
	const projected: JsonRecord = {};
	setIfDefined(projected, "output_text", asString(response.output_text, MAX_OUTPUT_TEXT));
	if (Array.isArray(response.output)) {
		const output = response.output
			.slice(0, MAX_LIST)
			.map(projectItem)
			.filter((item): item is JsonRecord => Boolean(item));
		if (output.length > 0) projected.output = output;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

/** Return an allow-listed, bounded event suitable for `data:` in SSE. */
export function projectSseEvent(value: unknown, depth = 0): JsonRecord {
	if (typeof value === "string" && depth < 2) {
		try {
			return projectSseEvent(JSON.parse(value), depth + 1);
		} catch {
			return { type: "stream.message" };
		}
	}
	const source = asRecord(value);
	if (!source) return { type: "stream.message" };
	const type = asString(source.type, 200) ?? "stream.message";
	const projected: JsonRecord = { type };

	for (const key of ["item_id", "runId", "step", "error", "message"]) {
		setIfDefined(projected, key, asString(source[key], key === "error" || key === "message" ? 1_000 : 500));
	}
	for (const key of ["sequence_number", "output_index", "content_index", "summary_index", "progress", "attempt", "delayMs"]) {
		setIfDefined(projected, key, finiteNumber(source[key]));
	}

	// The visit's live view: the tab's screen, each recorded page, the agent's actions, and downloads.
	if (type.startsWith("browser.")) {
		if (typeof source.jpeg === "string" && source.jpeg.length <= MAX_BROWSER_FRAME && /^[A-Za-z0-9+/=]+$/.test(source.jpeg)) projected.jpeg = source.jpeg;
		for (const key of ["url", "title", "kind", "text", "fileName"]) setIfDefined(projected, key, asString(source[key], 1_000));
		setIfDefined(projected, "index", finiteNumber(source.index));
	}

	if (type.startsWith("response.")) {
		setIfDefined(projected, "response", projectResponse(source.response));
		setIfDefined(projected, "item", projectItem(source.item));
		setIfDefined(projected, "part", projectContent(source.part));
		setIfDefined(projected, "delta", asString(source.delta, MAX_OUTPUT_TEXT));
		setIfDefined(projected, "text", asString(source.text, MAX_OUTPUT_TEXT));
		setIfDefined(projected, "refusal", asString(source.refusal, MAX_OUTPUT_TEXT));
	}

	return projected;
}

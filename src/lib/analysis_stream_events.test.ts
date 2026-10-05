import { describe, expect, test } from "bun:test";

import {
	applyAnalysisStreamEvent,
	createInitialAnalysisStreamState,
	extractOutputText,
	humanizeAnalysisStep,
	markAnalysisStreamError,
} from "./analysis_stream_events";

describe("analysis SSE event projection", () => {
	test("groups web-search lifecycle packets into one readable tool entry", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, {
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 2,
			item: { id: "search-1", type: "web_search_call", status: "in_progress" },
		});
		state = applyAnalysisStreamEvent(state, {
			type: "response.web_search_call.in_progress",
			sequence_number: 2,
			item_id: "search-1",
			output_index: 2,
		});
		state = applyAnalysisStreamEvent(state, {
			type: "response.web_search_call.searching",
			sequence_number: 3,
			item_id: "search-1",
			output_index: 2,
		});
		state = applyAnalysisStreamEvent(state, {
			type: "response.output_item.done",
			sequence_number: 4,
			output_index: 2,
			item: {
				id: "search-1",
				type: "web_search_call",
				status: "completed",
				action: { type: "search", queries: ["Swiss Capital loans", "swisscapitalloans"] },
			},
		});
		state = applyAnalysisStreamEvent(state, {
			type: "response.web_search_call.completed",
			sequence_number: 5,
			item_id: "search-1",
			output_index: 2,
		});

		const tools = state.entries.filter((entry) => entry.kind === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({
			status: "complete",
			phase: "Done",
			queryCount: 2,
		});
	});

	test("understands the privacy-preserving search count sent over SSE", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, {
			type: "response.output_item.done",
			item: { id: "search-count", type: "web_search_call", status: "completed", action: { query_count: 3 } },
		});
		expect(state.entries[0]).toMatchObject({ kind: "tool", queryCount: 3 });
	});

	test("renders reasoning summaries while never retaining encrypted reasoning content", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, {
			type: "response.output_item.added",
			sequence_number: 1,
			item: { id: "reasoning-1", type: "reasoning", encrypted_content: "secret-token-material", summary: [] },
		});
		state = applyAnalysisStreamEvent(state, {
			type: "response.reasoning_summary_text.delta",
			sequence_number: 2,
			item_id: "reasoning-1",
			summary_index: 0,
			delta: "Checking the domain",
		});
		state = applyAnalysisStreamEvent(state, {
			type: "response.reasoning_summary_text.done",
			sequence_number: 3,
			item_id: "reasoning-1",
			summary_index: 0,
			text: "Checking the domain",
		});

		expect(state.entries.filter((entry) => entry.kind === "reasoning")).toHaveLength(1);
		expect(state.entries[0]).toMatchObject({ kind: "reasoning", text: "Checking the domain", status: "complete" });
		expect(JSON.stringify(state)).not.toContain("secret-token-material");
		expect(JSON.stringify(state)).not.toContain("encrypted_content");
	});

	test("hydrates a late output-item packet and deduplicates replayed sequence numbers", () => {
		let state = createInitialAnalysisStreamState("running");
		const event = {
			type: "response.output_item.done",
			sequence_number: 10,
			item: { id: "reasoning-2", type: "reasoning", summary: [{ type: "summary_text", text: "Late summary" }] },
		};
		state = applyAnalysisStreamEvent(state, event);
		state = applyAnalysisStreamEvent(state, event);
		expect(state.entries).toHaveLength(1);
		expect(state.entries.filter((entry) => entry.kind === "reasoning")).toHaveLength(1);
		expect(state.entries[0]).toMatchObject({ text: "Late summary" });
	});

	test("accepts reasoning text from part.done when no text-delta packets were emitted", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, {
			type: "response.reasoning_summary_part.done",
			sequence_number: 21,
			item_id: "reasoning-3",
			summary_index: 1,
			part: { type: "summary_text", text: "Part-level summary" },
		});
		expect(state.entries).toHaveLength(1);
		expect(state.entries[0]).toMatchObject({ kind: "reasoning", text: "Part-level summary", status: "complete" });
	});

	test("keeps streamed answer text separate from protocol activity", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, { type: "response.output_text.delta", sequence_number: 1, delta: "Verdict: " });
		state = applyAnalysisStreamEvent(state, { type: "response.output_text.delta", sequence_number: 2, delta: "phishing" });
		state = applyAnalysisStreamEvent(state, { type: "response.output_text.done", sequence_number: 3, text: "Verdict: phishing" });
		expect(state.outputText).toBe("Verdict: phishing");
	});

	test("does not move a running check backwards when the response starts", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, { type: "response.created", sequence_number: 1, response: { status: "in_progress" } });
		expect(state.runStatus).toBe("running");
	});

	test("shows queued submissions as starting until work begins", () => {
		expect(createInitialAnalysisStreamState("queued").runStatus).toBe("created");
		expect(createInitialAnalysisStreamState("new").runStatus).toBe("created");
	});

	test("maps retries and failures to visible statuses", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, {
			type: "run.retrying",
			attempt: 2,
			maxAttempts: 3,
			delayMs: 1_250,
			error: "provider timeout",
		});
		expect(state.runStatus).toBe("retrying");
		expect(state.entries[0]).toMatchObject({ status: "warning", detail: "We'll try again in 2s." });
		state = applyAnalysisStreamEvent(state, { type: "run.failed", runId: "42", error: "provider unavailable" });
		expect(state.runStatus).toBe("failed");
		expect(state.error).toBe("provider unavailable");
		expect(state.entries.at(-1)).toMatchObject({ status: "failed", title: "Analysis couldn't finish" });
	});

	test("extracts persisted assistant text and refusals", () => {
		expect(
			extractOutputText([
				{ type: "reasoning", content: [] },
				{
					type: "message",
					content: [
						{ type: "output_text", text: "first" },
						{ type: "output_text", text: " second" },
					],
				},
			]),
		).toBe("first second");
		expect(extractOutputText([{ type: "message", content: [{ type: "refusal", refusal: "Cannot help" }] }])).toBe(
			"Refusal: Cannot help",
		);
	});

	test("uses reader-friendly labels for internal pipeline steps", () => {
		expect(humanizeAnalysisStep("analysis_run")).toBe("Reviewing the submission");
		expect(humanizeAnalysisStep("website_capture")).toBe("Capturing the website");
		expect(humanizeAnalysisStep("whois_lookup")).toBe("Checking domain details");
	});

	test("does not collapse distinct progress updates that share a topic", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, { type: "analysis.step", step: "archive_website", progress: 10 });
		state = applyAnalysisStreamEvent(state, { type: "analysis.step", step: "save_artifacts", progress: 40 });
		state = applyAnalysisStreamEvent(state, { type: "analysis.step", step: "analysis_run", progress: 45 });
		expect(state.entries.filter((entry) => entry.kind === "step")).toHaveLength(3);
	});

	test("shows a failed pipeline step as a problem rather than as finished", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, { type: "analysis.step", step: "failed", progress: 100 });
		expect(state.runStatus).toBe("failed");
		expect(state.entries[0]).toMatchObject({ kind: "step", status: "failed" });
	});

	test("does not report a terminal stream disconnect as an error", () => {
		let state = createInitialAnalysisStreamState("completed");
		state = markAnalysisStreamError(state);
		expect(state.connection).toBe("closed");
		expect(state.error).toBeNull();
	});

	test("keeps a submission-level progress failure visible after the main result", () => {
		let state = createInitialAnalysisStreamState("completed", true);
		state = markAnalysisStreamError(state, "Progress updates paused.");
		expect(state.connection).toBe("error");
		expect(state.error).toBe("Progress updates paused.");
	});

	test("ignores unsupported event payloads", () => {
		let state = createInitialAnalysisStreamState("running");
		state = applyAnalysisStreamEvent(state, { type: "provider.future_event", sequence_number: 77, secret: "never render this" });
		expect(state.entries).toHaveLength(0);
		expect(JSON.stringify(state)).not.toContain("never render this");
	});
});

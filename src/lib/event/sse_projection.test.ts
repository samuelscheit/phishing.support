import { describe, expect, test } from "bun:test";

import { projectSseEvent } from "./sse_projection";

describe("SSE event projection", () => {
	test("keeps semantic fields and removes encrypted or arbitrary nested payloads", () => {
		const projected = projectSseEvent({
			type: "response.output_item.done",
			sequence_number: 12,
			output_index: 2,
			item: {
				id: "reasoning-1",
				type: "reasoning",
				status: "completed",
				encrypted_content: "do-not-send",
				summary: [{ type: "summary_text", text: "Reviewing the domain" }],
				private_field: "also-do-not-send",
			},
			extra_nested_payload: { token: "do-not-send" },
		});

		expect(projected).toEqual({
			type: "response.output_item.done",
			sequence_number: 12,
			output_index: 2,
			item: {
				id: "reasoning-1",
				type: "reasoning",
				status: "completed",
				summary: [{ type: "summary_text", text: "Reviewing the domain" }],
			},
		});
		expect(JSON.stringify(projected)).not.toContain("do-not-send");
	});

	test("projects response output enough for a late subscriber to recover the answer", () => {
		const projected = projectSseEvent({
			type: "response.completed",
			response: {
				id: "resp-1",
				status: "completed",
				model: "gpt-5.5",
				output: [
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: "The result" }] },
					{ type: "reasoning", encrypted_content: "hidden", summary: [{ type: "summary_text", text: "A thought" }] },
				],
				usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, private: "hidden" },
			},
		});

		expect(projected.response).toEqual({
			output: [
				{ type: "message", content: [{ type: "output_text", text: "The result" }] },
				{ type: "reasoning", summary: [{ type: "summary_text", text: "A thought" }] },
			],
		});
		expect(JSON.stringify(projected)).not.toContain("hidden");
	});

	test("serializes bigint run identifiers for browser JSON", () => {
		expect(projectSseEvent({ type: "run.created", runId: 123n })).toEqual({ type: "run.created", runId: "123" });
	});

	test("accepts a JSON string from an IPC-backed event transport", () => {
		expect(projectSseEvent('{"type":"analysis.step","step":"reporting","progress":90}')).toEqual({
			type: "analysis.step",
			step: "reporting",
			progress: 90,
		});
	});

	test("keeps only the number of searches from the provider's object-shaped action format", () => {
		const projected = projectSseEvent({
			type: "response.output_item.done",
			item: { type: "web_search_call", action: { queries: [{ search_query: { q: "official site" } }] } },
		});
		expect(projected).toMatchObject({ item: { action: { query_count: 1 } } });
		expect(JSON.stringify(projected)).not.toContain("official site");
	});
});

import { describe, expect, test } from "bun:test";

import { summarizeAnalysisEntries } from "./analysis_stream_view";

describe("reader-friendly analysis activity", () => {
	test("combines repeated notes and searches into a short activity list", () => {
		const entries = summarizeAnalysisEntries([
			{
				kind: "step",
				id: "step:analysis_run",
				step: "analysis_run",
				progress: 45,
				status: "active",
			},
			{
				kind: "reasoning",
				id: "reasoning:1:0",
				text: "Checking the domain",
				status: "complete",
			},
			{
				kind: "tool",
				id: "tool:1",
				toolType: "web_search_call",
				phase: "Done",
				status: "complete",
				queryCount: 2,
			},
			{
				kind: "reasoning",
				id: "reasoning:2:0",
				text: "Comparing the information",
				status: "complete",
			},
			{
				kind: "tool",
				id: "tool:2",
				toolType: "web_search_call",
				phase: "Done",
				status: "complete",
				queryCount: 2,
			},
		]);

		expect(entries).toHaveLength(3);
		expect(entries.map((entry) => entry.kind)).toEqual(["step", "reasoning", "tool"]);
		expect(entries[1]).toMatchObject({
			title: "Reviewing the evidence",
			text: "Comparing the information",
			earlierTexts: ["Checking the domain"],
		});
		expect(entries[2]).toMatchObject({ title: "Related information checked", phase: "Finished", queryCount: 4 });
	});

	test("keeps the reader summary compact even for a busy run", () => {
		const entries = summarizeAnalysisEntries([
			...Array.from({ length: 12 }, (_, index) => ({
				kind: "reasoning" as const,
				id: `reasoning:${index}`,
				text: `Update ${index}`,
				status: "complete" as const,
			})),
			...Array.from({ length: 8 }, (_, index) => ({
				kind: "tool" as const,
				id: `tool:${index}`,
				toolType: "web_search_call",
				phase: "Done",
				status: "complete" as const,
				queryCount: 1,
			})),
		]);
		const reasoning = entries.find((entry) => entry.kind === "reasoning");
		const research = entries.find((entry) => entry.kind === "tool");
		expect(reasoning?.earlierTexts.length).toBeLessThanOrEqual(8);
		expect(research?.queryCount).toBe(8);
	});

	test("marks earlier pipeline steps as finished when a later step is active", () => {
		const entries = summarizeAnalysisEntries([
			{
				kind: "step",
				id: "step:one",
				step: "whois_lookup",
				progress: 5,
				status: "active",
			},
			{
				kind: "step",
				id: "step:two",
				step: "analysis_run",
				progress: 45,
				status: "active",
			},
		]);
		expect(entries[0]).toMatchObject({ status: "complete" });
		expect(entries[1]).toMatchObject({ status: "active" });
	});
});

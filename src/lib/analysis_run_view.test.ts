import { describe, expect, test } from "bun:test";

import { selectDisplayAnalysisRuns } from "./analysis_run_view";

const run = (analysisKind: "analysis" | "classification", id: number) => ({ analysisKind, id });

describe("analysis run display selection", () => {
	test("hides classification runs and keeps the latest detailed analysis", () => {
		const first = run("analysis", 1);
		const second = run("analysis", 2);
		expect(selectDisplayAnalysisRuns([first, run("classification", 3), second, run("classification", 4)])).toEqual([second]);
	});

	test("does not expose machine-only runs as a fake analysis", () => {
		expect(selectDisplayAnalysisRuns([run("classification", 1)])).toEqual([]);
		expect(selectDisplayAnalysisRuns([])).toEqual([]);
	});
});

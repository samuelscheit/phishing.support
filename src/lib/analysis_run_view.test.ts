import { describe, expect, test } from "bun:test";

import { isMachineAnalysisRun, selectDisplayAnalysisRuns } from "./analysis_run_view";

function run(overrides: Record<string, unknown> = {}) {
	return {
		analysisKind: "unknown",
		createdAt: new Date(),
		output: [{ type: "message", content: [{ type: "output_text", text: "Detailed phishing evidence." }] }],
		...overrides,
	} as any;
}

describe("analysis run display selection", () => {
	test("hides an explicit classification run and keeps the detailed analysis", () => {
		const detailed = run({ analysisKind: "analysis" });
		const classification = run({ analysisKind: "classification", output: [{ type: "message", content: [{ type: "output_text", text: '{"phishing":true}' }] }] });

		expect(isMachineAnalysisRun(classification)).toBe(true);
		expect(selectDisplayAnalysisRuns([detailed, classification])).toEqual([detailed]);
	});

	test("recognizes machine output from legacy rows without analysis kind", () => {
		const legacyClassification = run({ output: [{ type: "message", content: [{ type: "output_text", text: '{"phishing":true}' }] }] });
		const legacyReportDraft = run({ output: [{ type: "message", content: [{ type: "output_text", text: '{"to":"abuse@example.test","subject":"Report","body":"Please investigate."}' }] }] });
		const prose = run({ output: [{ type: "message", content: [{ type: "output_text", text: "Verdict: high-confidence phishing. The page impersonates a bank." }] }] });

		expect(isMachineAnalysisRun(legacyClassification)).toBe(true);
		expect(isMachineAnalysisRun(legacyReportDraft)).toBe(true);
		expect(isMachineAnalysisRun(prose)).toBe(false);
		expect(selectDisplayAnalysisRuns([prose, legacyClassification])).toEqual([prose]);
	});

	test("does not expose machine-only runs as a fake analysis", () => {
		const classification = run({ analysisKind: "classification", output: [{ type: "message", content: [{ type: "output_text", text: '{"phishing":false}' }] }] });
		expect(selectDisplayAnalysisRuns([classification])).toEqual([]);
	});

	test("recognizes an in-flight legacy classifier from its system prompt", () => {
		const classification = run({
			output: null,
			input: [{ role: "system", content: "Classify the website from the supplied evidence." }],
		});
		expect(isMachineAnalysisRun(classification)).toBe(true);
		expect(selectDisplayAnalysisRuns([classification])).toEqual([]);
	});
});

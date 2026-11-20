import type { AnalysisRun } from "../db/schema";

/** The subset of a persisted run required to choose the user-facing analysis. */
export type AnalysisRunViewInput = Pick<AnalysisRun, "analysisKind">;

/**
 * Return the latest human-readable analysis run. A submission may have a
 * narrative run followed by one or more machine-only classification runs;
 * showing the last row would otherwise render only {"phishing":true}.
 */
export function selectDisplayAnalysisRuns<T extends AnalysisRunViewInput>(runs: T[]): T[] {
	const latest = runs.findLast((run) => run.analysisKind === "analysis");
	return latest ? [latest] : [];
}

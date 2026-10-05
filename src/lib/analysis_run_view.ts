import type { AnalysisRun, AnalysisRunKind } from "./db/schema";
import type { ResponseInputItem } from "openai/resources/responses/responses.mjs";

type OutputContent = { type?: string; text?: string; refusal?: string };
type OutputItem = { type?: string; content?: OutputContent[] };

/** The subset of a persisted run required to choose the user-facing analysis. */
export type AnalysisRunViewInput = Pick<AnalysisRun, "output" | "createdAt" | "input"> & {
	/** Older rows (before analysis_kind existed) may not have this field in API payloads. */
	analysisKind?: AnalysisRunKind | null;
};

function outputText(run: AnalysisRunViewInput): string {
	if (!Array.isArray(run.output)) return "";
	return (run.output as unknown as OutputItem[])
		.filter((item) => item?.type === "message" && Array.isArray(item.content))
		.flatMap((item) =>
			(item.content ?? []).map((content) => {
				if (content.type === "output_text") return content.text ?? "";
				if (content.type === "refusal") return content.refusal ?? "Refusal";
				return "";
			}),
		)
		.join("")
		.trim();
}

function hasExactObjectKeys(value: unknown, keys: string[]): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value as Record<string, unknown>).sort();
	return actual.length === keys.length && actual.every((key, index) => key === keys.slice().sort()[index]);
}

function systemPrompt(run: AnalysisRunViewInput): string {
	const system = (run.input as ResponseInputItem[] | null | undefined)?.find((item) => (item as { role?: string }).role === "system");
	if (!system || !("content" in system)) return "";
	if (typeof system.content === "string") return system.content.trim();
	if (!Array.isArray(system.content)) return "";
	return system.content
		.map((part) => (typeof part === "object" && part && "text" in part && typeof part.text === "string" ? part.text : ""))
		.join(" ")
		.trim();
}

/**
 * Identifies machine-only runs, including historical rows written before the
 * explicit analysis kind was persisted. Classification output is deliberately
 * strict so a prose analysis containing JSON snippets is still displayed.
 */
export function isMachineAnalysisRun(run: AnalysisRunViewInput): boolean {
	if (run.analysisKind === "classification" || run.analysisKind === "report_draft") return true;
	if (run.analysisKind === "analysis") return false;

	const prompt = systemPrompt(run);
	if (/^Classify the (?:website|email)\b/i.test(prompt) || /\bdraft(?: a| the)? (?:concise )?report\b/i.test(prompt)) return true;

	const text = outputText(run);
	if (!text) return false;
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		if (hasExactObjectKeys(parsed, ["phishing"]) && typeof parsed.phishing === "boolean") return true;
		if (hasExactObjectKeys(parsed, ["to", "subject", "body"]) && Object.values(parsed).every((value) => typeof value === "string")) return true;
	} catch {
		// Non-JSON output is a human-readable analysis and should remain visible.
	}
	return false;
}

/**
 * Return the latest human-readable analysis run. A submission may have a
 * narrative run followed by one or more machine-only classification/report
 * runs; showing the last row would otherwise render only {"phishing":true}.
 */
export function selectDisplayAnalysisRuns<T extends AnalysisRunViewInput>(runs: T[]): T[] {
	const visible = runs.filter((run) => !isMachineAnalysisRun(run));
	if (visible.length === 0) return [];
	const explicitAnalysis = visible.filter((run) => run.analysisKind === "analysis");
	return [explicitAnalysis.at(-1) ?? visible.at(-1)!];
}

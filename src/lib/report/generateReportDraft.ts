import { runStreamedAnalysisRun } from "../analysis_run";
import { defaultResponseModel } from "../utils";

export type ReportDraft = {
	to: string;
	subject: string;
	body: string;
	/** The analysis run that generated this report draft, when persisted. */
	analysisRunId?: bigint;
};

export async function generateReportDraft(params: {
	submissionId: bigint;
	system: string;
	user: string;
	withoutHeader?: boolean;
}): Promise<ReportDraft> {
	const { runId, result } = await runStreamedAnalysisRun({
		submissionId: params.submissionId,
		analysisKind: "report_draft",
		options: {
			model: defaultResponseModel,
			input: [
				{ role: "system", content: params.system },
				{ role: "user", content: params.user },
			],
			text: {
				format: {
					type: "json_schema",
					name: "report_email",
					schema: {
						type: "object",
						properties: params.withoutHeader
							? {
									body: { type: "string" },
								}
							: {
									to: { type: "string" },
									subject: { type: "string" },
									body: { type: "string" },
								},
						required: params.withoutHeader ? ["body"] : ["to", "subject", "body"],
						additionalProperties: false,
					},
					strict: true,
				},
				verbosity: "low",
			},
			stream: true,
		},
	});
	if (!result.output_parsed) throw new Error("Failed to parse report draft response: " + result.output_text);

	return {
		...(result.output_parsed as ReportDraft),
		analysisRunId: runId,
	};
}

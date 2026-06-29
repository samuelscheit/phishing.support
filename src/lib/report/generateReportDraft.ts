import { runStreamedAnalysisRun } from "../analysis_run";
import { defaultResponseModel } from "../utils";

export type ReportDraft = {
	to: string;
	subject: string;
	body: string;
};

export async function generateReportDraft(params: {
	submissionId: bigint;
	system: string;
	user: string;
	withoutHeader?: boolean;
}): Promise<ReportDraft> {
	const { result } = await runStreamedAnalysisRun({
		submissionId: params.submissionId,
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

	return result.output_parsed as ReportDraft;
}

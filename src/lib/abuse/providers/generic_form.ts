import { hashStableJson } from "../security";

/**
 * The generic email-form adapter is not a named provider: it is an opt-in
 * fallback entered only after a verified email route explicitly supplies an
 * in-boundary form URL.
 */
export type GenericProviderFormDefinition = {
	key: "generic_verified_provider_form";
	version: string;
	contentHash: string;
	requiredSemanticLandmarks: string[];
	requiredFields: string[];
	extractionSchema: Record<string, unknown>;
	maxDescriptionLength: number;
	maxEvidenceImages: number;
	maxEvidenceBytesPerImage: number;
};

const definitionWithoutHash = {
	key: "generic_verified_provider_form" as const,
	version: "2026-08-13.1",
	requiredSemanticLandmarks: [
		"provider abuse-report form",
		"target/domain/IP field",
		"allegation category or report-type field",
		"description field",
		"final report submit control",
	],
	requiredFields: ["target", "allegationCategory", "description"],
	extractionSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			form_contract_passed: { type: "boolean" },
			confirmation_text: { type: "string" },
			confirmation_id: { type: "string" },
			final_url: { type: "string" },
			submitted_domains: { type: "array", items: { type: "string" } },
			submitted_urls: { type: "array", items: { type: "string" } },
			provider_errors: { type: "array", items: { type: "string" } },
			form_drift: { type: "boolean" },
			form_drift_reason: { type: "string" },
			final_submit_clicked: { type: "boolean" },
			final_submit_control: { type: "string", enum: ["provider_report_submit"] },
			irreversible_actions: { type: "array", items: { type: "string", enum: ["provider_report_submit"] }, maxItems: 1 },
		},
		required: ["form_contract_passed", "confirmation_text", "final_url", "submitted_domains", "submitted_urls", "provider_errors", "form_drift", "final_submit_clicked", "final_submit_control", "irreversible_actions"],
	},
	maxDescriptionLength: 5_000,
	maxEvidenceImages: 15,
	maxEvidenceBytesPerImage: 2 * 1024 * 1024,
};

export const GENERIC_PROVIDER_FORM_ADAPTER: GenericProviderFormDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});

export function genericProviderFormAdapterHasValidHash(definition: GenericProviderFormDefinition = GENERIC_PROVIDER_FORM_ADAPTER): boolean {
	const { contentHash, ...withoutHash } = definition;
	return contentHash === hashStableJson(withoutHash);
}

/** Generic provider-form escalation is separately switchable. */
export function isGenericFormEscalationEnabled(): boolean {
	return process.env.ABUSE_GENERIC_FORM_ESCALATION_ENABLED === "true";
}

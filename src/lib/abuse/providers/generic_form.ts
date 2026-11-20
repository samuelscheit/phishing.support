import { hashStableJson } from "../../util/hash";

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
	/** JSON schema of the result the browser task agent must finish with. */
	resultSchema: Record<string, unknown>;
	maxDescriptionLength: number;
};

const definitionWithoutHash = {
	key: "generic_verified_provider_form" as const,
	version: "2026-11-17.1",
	requiredSemanticLandmarks: [
		"provider abuse-report form",
		"target/domain/IP field",
		"allegation category or report-type field",
		"description field",
		"final report submit control",
	],
	resultSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			form_contract_passed: { type: "boolean", description: "Every required landmark was present and filled from the report payload." },
			confirmation_text: { type: "string", description: "The provider's confirmation message after submitting, verbatim; empty when nothing was submitted." },
			confirmation_id: { type: "string", description: "A ticket or case number the confirmation shows, if any." },
			final_url: { type: "string", description: "The URL of the page shown at the end." },
			submitted_domains: { type: "array", items: { type: "string" }, description: "The report target as submitted (the payload's target)." },
			submitted_urls: { type: "array", items: { type: "string" }, description: "The observed URLs as submitted (the payload's observedUrls)." },
			provider_errors: { type: "array", items: { type: "string" }, description: "Validation or error messages the provider showed, verbatim." },
			form_drift: { type: "boolean", description: "The form, its submit control or its origin differ materially from what is expected, so nothing was submitted." },
			form_drift_reason: { type: "string" },
			final_submit_clicked: { type: "boolean" },
			final_submit_control: { type: "string", enum: ["provider_report_submit", "none"], description: "provider_report_submit when the final report-submit control was clicked, otherwise none." },
			irreversible_actions: { type: "array", items: { type: "string", enum: ["provider_report_submit"] }, maxItems: 1 },
		},
		required: ["form_contract_passed", "confirmation_text", "final_url", "submitted_domains", "submitted_urls", "provider_errors", "form_drift", "final_submit_clicked", "final_submit_control", "irreversible_actions"],
	},
	maxDescriptionLength: 5_000,
};

export const GENERIC_PROVIDER_FORM_ADAPTER: GenericProviderFormDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});

export function genericProviderFormAdapterHasValidHash(definition: GenericProviderFormDefinition = GENERIC_PROVIDER_FORM_ADAPTER): boolean {
	const { contentHash, ...withoutHash } = definition;
	return contentHash === hashStableJson(withoutHash);
}

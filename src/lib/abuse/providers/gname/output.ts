import { normalizeDomain } from "../../security";
import {
	validateSkyvernOutputContract,
	type SkyvernOutputContract,
} from "../../skyvern/output_validation";
import { GNAME_PROVIDER } from "./definition";
import { gnameDefinitionHasValidHash, gnamePinnedEntryUrl } from "./definition_integrity";

const GNAME_OUTPUT_KEYS = [
	"form_contract_passed",
	"confirmation_text",
	"confirmation_id",
	"final_url",
	"submitted_domains",
	"submitted_urls",
	"provider_errors",
	"form_drift",
	"form_drift_reason",
	"final_submit_clicked",
	"final_submit_control",
	"declaration_checked",
	"declaration_contract",
	"irreversible_actions",
] as const;

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? value as string[]
		: undefined;
}

function contractFailure(reason: string): SkyvernOutputContract {
	return { passed: false, reason, submittedTargets: [] };
}

/**
 * Validate GNAME's pinned form contract, including its mandatory service
 * declaration. This is intentionally provider-local: generic Skyvern code
 * validates only the common irreversible-submit protocol.
 */
export function validateGnameSkyvernOutput(params: {
	output: unknown;
	providerPayload: unknown;
}): SkyvernOutputContract {
	const payload = recordValue(params.providerPayload);
	const immutableContract = payload && recordValue(payload.contract);
	if (!immutableContract) return contractFailure("immutable_output_contract_missing");
	const domains = stringArray(immutableContract.domains);
	const observedUrls = stringArray(immutableContract.observedUrls);
	const entryUrl = typeof immutableContract.entryUrl === "string" ? immutableContract.entryUrl : undefined;
	const definition = GNAME_PROVIDER;
	return validateSkyvernOutputContract({
		output: params.output,
		policy: {
			allowedOutputKeys: GNAME_OUTPUT_KEYS,
			expectedTargets: domains ?? [],
			expectedUrls: observedUrls ?? [],
			entryUrl: entryUrl ?? "",
			allowedFinalDomains: definition.verifiedDomains,
			isValidTarget: (domain) => Boolean(normalizeDomain(domain)),
			validateImmutableContract: () => {
				if (!domains || !observedUrls || observedUrls.length === 0) return "immutable_output_contract_invalid";
				if (!gnameDefinitionHasValidHash(definition)) return "provider_definition_invalid";
				if (
					immutableContract.providerDefinitionVersion !== definition.version
					|| immutableContract.providerDefinitionHash !== definition.contentHash
				) {
					return "provider_definition_pin_mismatch";
				}
				if (!entryUrl) return "immutable_entry_url_missing";
				if (!gnamePinnedEntryUrl(entryUrl, definition)) return "immutable_entry_url_drift";
				return undefined;
			},
			validateOutput: (output) => output.declaration_checked === true && output.declaration_contract === "gname_service_declaration_v1"
				? undefined
				: "gname_declaration_contract_mismatch",
		},
	});
}

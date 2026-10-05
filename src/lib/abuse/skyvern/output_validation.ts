import { isPublicIp, normalizeDomain } from "../security";
import {
	boundedString,
	exactAllowedHttpsUrl,
	exactStringSet,
	isExactAllowedFinalUrl,
	normalizeAllowedDomains,
} from "./provider_contract";

export type SkyvernOutputContract = {
	passed: boolean;
	reason?: string;
	confirmationId?: string;
	confirmationText?: string;
	finalUrl?: string;
	submittedTargets: string[];
};

/**
 * A code-owned output policy supplied by the concrete form adapter. The
 * Skyvern boundary only validates an immutable submission contract; it never
 * switches on a provider name or imports a concrete provider definition.
 */
export type SkyvernOutputValidationPolicy = {
	allowedOutputKeys: readonly string[];
	expectedTargets: readonly string[];
	expectedUrls: readonly string[];
	entryUrl: string;
	allowedFinalDomains: readonly string[];
	isValidTarget(target: string): boolean;
	/** Validate definition pins and other immutable adapter state after target checks. */
	validateImmutableContract?(): string | undefined;
	/** Validate adapter-specific extraction fields after immutable state checks. */
	validateOutput?(output: Record<string, unknown>): string | undefined;
};

const GENERIC_PROVIDER_FORM_OUTPUT_KEYS = [
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
 * Validate the shared irreversible-submit portion of a Skyvern extraction.
 * Concrete providers pass only code-owned policy values; their custom fields
 * and pinning rules remain in their own module.
 */
export function validateSkyvernOutputContract(params: {
	output: unknown;
	policy: SkyvernOutputValidationPolicy;
}): SkyvernOutputContract {
	const output = recordValue(params.output);
	if (!output) return contractFailure("form_contract_output_invalid");
	const allowedKeys = new Set(params.policy.allowedOutputKeys);
	if (Object.keys(output).some((key) => !allowedKeys.has(key))) return contractFailure("unexpected_extraction_output");
	if (typeof output.form_contract_passed !== "boolean" || typeof output.form_drift !== "boolean") {
		return contractFailure("form_contract_output_invalid");
	}
	if (output.form_drift === true) {
		return contractFailure(boundedString(output.form_drift_reason, 2_000) ? output.form_drift_reason : "provider_form_drift");
	}
	if (output.form_contract_passed !== true) return contractFailure("form_contract_not_passed");
	if (output.final_submit_clicked !== true || output.final_submit_control !== "provider_report_submit") {
		return contractFailure("final_submit_contract_missing");
	}
	if (
		!Array.isArray(output.irreversible_actions)
		|| output.irreversible_actions.length !== 1
		|| output.irreversible_actions[0] !== "provider_report_submit"
	) {
		return contractFailure("unexpected_irreversible_action");
	}
	if (
		!Array.isArray(output.provider_errors)
		|| output.provider_errors.some((item) => !boundedString(item, 2_000))
		|| output.provider_errors.length > 50
	) {
		return contractFailure("provider_error_output_invalid");
	}
	if (output.provider_errors.length > 0) return contractFailure("provider_reported_error");

	if (
		params.policy.expectedTargets.length === 0
		|| params.policy.expectedTargets.some((target) => !params.policy.isValidTarget(target))
		|| params.policy.expectedUrls.some((url) => !boundedString(url, 4_096, 1))
		|| !exactStringSet(output.submitted_domains, [...params.policy.expectedTargets])
		|| !exactStringSet(output.submitted_urls, [...params.policy.expectedUrls])
	) {
		return contractFailure("submitted_target_contract_mismatch");
	}

	const immutableFailure = params.policy.validateImmutableContract?.();
	if (immutableFailure) return contractFailure(immutableFailure);
	const outputFailure = params.policy.validateOutput?.(output);
	if (outputFailure) return contractFailure(outputFailure);
	const allowedDomains = normalizeAllowedDomains(params.policy.allowedFinalDomains);
	if (!allowedDomains || allowedDomains.length === 0) return contractFailure("allowed_final_domains_invalid");
	if (!exactAllowedHttpsUrl(params.policy.entryUrl, allowedDomains)) return contractFailure("immutable_entry_url_invalid");
	if (!isExactAllowedFinalUrl(output.final_url, allowedDomains)) return contractFailure("final_url_origin_drift");
	if (!boundedString(output.confirmation_text, 4_000, 1) || !output.confirmation_text.trim()) {
		return contractFailure("confirmation_text_missing");
	}
	if (output.confirmation_id !== undefined && !boundedString(output.confirmation_id, 512)) {
		return contractFailure("confirmation_id_invalid");
	}
	return {
		passed: true,
		confirmationId: typeof output.confirmation_id === "string" ? output.confirmation_id : undefined,
		confirmationText: output.confirmation_text,
		finalUrl: output.final_url as string,
		submittedTargets: output.submitted_domains as string[],
	};
}

/** Validate the provider-neutral verified-email form escalation adapter. */
export function validateGenericProviderFormOutput(params: {
	output: unknown;
	providerPayload: unknown;
}): SkyvernOutputContract {
	const payload = recordValue(params.providerPayload);
	const immutableContract = payload && recordValue(payload.contract);
	if (!immutableContract) return contractFailure("immutable_output_contract_missing");
	const target = typeof immutableContract.target === "string" ? immutableContract.target : undefined;
	const observedUrls = stringArray(immutableContract.observedUrls);
	const allowedDomains = normalizeAllowedDomains(immutableContract.allowedFinalDomains) ?? [];
	const entryUrl = typeof immutableContract.entryUrl === "string" ? immutableContract.entryUrl : undefined;
	return validateSkyvernOutputContract({
		output: params.output,
		policy: {
			allowedOutputKeys: GENERIC_PROVIDER_FORM_OUTPUT_KEYS,
			expectedTargets: target ? [target] : [],
			expectedUrls: observedUrls ?? [],
			entryUrl: entryUrl ?? "",
			allowedFinalDomains: allowedDomains,
			isValidTarget: (candidate) => Boolean(normalizeDomain(candidate)) || isPublicIp(candidate),
			validateImmutableContract: () => {
				if (!entryUrl) return "immutable_entry_url_missing";
				if (!observedUrls) return "immutable_output_contract_invalid";
				return undefined;
			},
		},
	});
}

export function isTerminalSkyvernStatus(status: string | undefined): boolean {
	return ["completed", "failed", "terminated", "timed_out", "canceled"].includes(status ?? "");
}

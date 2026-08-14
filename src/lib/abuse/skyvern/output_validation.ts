import {
	getProviderDefinition,
	isProviderOriginAllowed,
	providerDefinitionHasValidHash,
} from "../registry";
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
 * A completed task is never proof that an irreversible provider form was
 * submitted correctly. Validate the code-owned extraction contract against
 * the immutable local run payload before allowing the route to become
 * `submitted`.
 */
export function validateSkyvernOutputContract(params: {
	output: Record<string, unknown>;
	providerKey: string;
	providerPayload: Record<string, unknown>;
}): SkyvernOutputContract {
	const output = params.output;
	const allowedKeys = params.providerKey === "gname"
		? new Set([
			"form_contract_passed", "confirmation_text", "confirmation_id", "final_url", "submitted_domains", "submitted_urls", "provider_errors", "form_drift", "form_drift_reason",
			"final_submit_clicked", "final_submit_control", "declaration_checked", "declaration_contract", "irreversible_actions",
		])
		: new Set([
			"form_contract_passed", "confirmation_text", "confirmation_id", "final_url", "submitted_domains", "submitted_urls", "provider_errors", "form_drift", "form_drift_reason",
			"final_submit_clicked", "final_submit_control", "irreversible_actions",
		]);
	if (Object.keys(output).some((key) => !allowedKeys.has(key))) {
		return { passed: false, reason: "unexpected_extraction_output", submittedTargets: [] };
	}
	if (typeof output.form_contract_passed !== "boolean" || typeof output.form_drift !== "boolean") {
		return { passed: false, reason: "form_contract_output_invalid", submittedTargets: [] };
	}
	if (output.form_drift === true) return { passed: false, reason: boundedString(output.form_drift_reason, 2_000) ? output.form_drift_reason : "provider_form_drift", submittedTargets: [] };
	if (output.form_contract_passed !== true) return { passed: false, reason: "form_contract_not_passed", submittedTargets: [] };
	if (output.final_submit_clicked !== true || output.final_submit_control !== "provider_report_submit") {
		return { passed: false, reason: "final_submit_contract_missing", submittedTargets: [] };
	}
	if (!Array.isArray(output.irreversible_actions) || output.irreversible_actions.length !== 1 || output.irreversible_actions[0] !== "provider_report_submit") {
		return { passed: false, reason: "unexpected_irreversible_action", submittedTargets: [] };
	}
	if (!Array.isArray(output.provider_errors) || output.provider_errors.some((item) => !boundedString(item, 2_000)) || output.provider_errors.length > 50) {
		return { passed: false, reason: "provider_error_output_invalid", submittedTargets: [] };
	}
	if (output.provider_errors.length > 0) return { passed: false, reason: "provider_reported_error", submittedTargets: [] };

	const immutableContract = params.providerPayload.contract && typeof params.providerPayload.contract === "object"
		? params.providerPayload.contract as Record<string, unknown>
		: undefined;
	if (!immutableContract) return { passed: false, reason: "immutable_output_contract_missing", submittedTargets: [] };
	const expectedTargets = params.providerKey === "gname"
		? Array.isArray(immutableContract.domains) ? immutableContract.domains.filter((item): item is string => typeof item === "string") : []
		: typeof immutableContract.target === "string" ? [immutableContract.target] : [];
	const expectedUrls = Array.isArray(immutableContract.observedUrls)
		? immutableContract.observedUrls.filter((item): item is string => typeof item === "string")
		: [];
	if (
		!expectedTargets.length
		// GNAME is intentionally domain-only. Generic verified-provider forms
		// can receive a public IP target, so validate that contract shape without
		// turning an IP into an invalid pseudo-domain.
		|| expectedTargets.some((target) => params.providerKey === "gname" ? !normalizeDomain(target) : (!normalizeDomain(target) && !isPublicIp(target)))
		|| expectedUrls.some((url) => !boundedString(url, 4_096, 1))
		|| !exactStringSet(output.submitted_domains, expectedTargets)
		|| !exactStringSet(output.submitted_urls, expectedUrls)
	) {
		return { passed: false, reason: "submitted_target_contract_mismatch", submittedTargets: [] };
	}

	const entryUrl = typeof immutableContract.entryUrl === "string" ? immutableContract.entryUrl : undefined;
	if (!entryUrl) return { passed: false, reason: "immutable_entry_url_missing", submittedTargets: [] };
	let allowedDomains: string[];
	if (params.providerKey === "gname") {
		const definition = getProviderDefinition("gname");
		if (!definition || !providerDefinitionHasValidHash(definition)) return { passed: false, reason: "provider_definition_invalid", submittedTargets: [] };
		if (immutableContract.providerDefinitionVersion !== definition.version || immutableContract.providerDefinitionHash !== definition.contentHash) {
			return { passed: false, reason: "provider_definition_pin_mismatch", submittedTargets: [] };
		}
		let parsedEntry: URL;
		try {
			parsedEntry = new URL(entryUrl);
		} catch {
			return { passed: false, reason: "immutable_entry_url_invalid", submittedTargets: [] };
		}
		if (!isProviderOriginAllowed(definition, parsedEntry) || parsedEntry.toString() !== definition.entryUrl) return { passed: false, reason: "immutable_entry_url_drift", submittedTargets: [] };
		if (output.declaration_checked !== true || output.declaration_contract !== "gname_service_declaration_v1") {
			return { passed: false, reason: "gname_declaration_contract_mismatch", submittedTargets: [] };
		}
		allowedDomains = normalizeAllowedDomains(definition.verifiedDomains) ?? [];
	} else {
		allowedDomains = normalizeAllowedDomains(immutableContract.allowedFinalDomains) ?? [];
		if (allowedDomains.length === 0) return { passed: false, reason: "allowed_final_domains_invalid", submittedTargets: [] };
	}
	if (params.providerKey !== "gname" && !exactAllowedHttpsUrl(entryUrl, allowedDomains)) {
		return { passed: false, reason: "immutable_entry_url_invalid", submittedTargets: [] };
	}
	if (!allowedDomains.length || !isExactAllowedFinalUrl(output.final_url, allowedDomains)) {
		return { passed: false, reason: "final_url_origin_drift", submittedTargets: [] };
	}
	if (!boundedString(output.confirmation_text, 4_000, 1) || !output.confirmation_text.trim()) {
		return { passed: false, reason: "confirmation_text_missing", submittedTargets: [] };
	}
	if (output.confirmation_id !== undefined && !boundedString(output.confirmation_id, 512)) {
		return { passed: false, reason: "confirmation_id_invalid", submittedTargets: [] };
	}
	return {
		passed: true,
		confirmationId: typeof output.confirmation_id === "string" ? output.confirmation_id : undefined,
		confirmationText: output.confirmation_text,
		finalUrl: output.final_url as string,
		submittedTargets: output.submitted_domains as string[],
	};
}

export function isTerminalSkyvernStatus(status: string | undefined): boolean {
	return ["completed", "failed", "terminated", "timed_out", "canceled"].includes(status ?? "");
}

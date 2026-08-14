import { normalizeDomain } from "../../security";
import type { SkyvernTaskPayload } from "../../skyvern/contracts";
import { isSafeSkyvernStorageUrl } from "../../skyvern/storage";
import { GNAME_PROVIDER } from "./definition";
import { gnameDefinitionHasValidHash, gnamePinnedEntryUrl } from "./definition_integrity";
import type { GnameTaskInput } from "./payload";

export type GnameTaskPayloadInput = GnameTaskInput & {
	presignedEvidenceUrls: string[];
};

function hasValidGnameDomains(domains: unknown): domains is string[] {
	return Array.isArray(domains)
		&& domains.length > 0
		&& domains.length <= 100
		&& new Set(domains).size === domains.length
		&& domains.every((domain) => typeof domain === "string" && Boolean(normalizeDomain(domain)));
}

function hasBoundedStringList(values: unknown, maximumItems: number): values is string[] {
	return Array.isArray(values)
		&& values.length > 0
		&& values.length <= maximumItems
		&& values.every((value) => typeof value === "string" && value.length > 0 && value.length <= 4_096);
}

/**
 * Construct the immutable Skyvern task for GNAME's reviewed category-2 form.
 * Every parameter is durable provider state, never page- or email-supplied
 * instructions. Keep this beside GNAME's definition so the generic Skyvern
 * adapter never learns the provider's fields, declaration, or upload policy.
 */
export function buildGnameTaskPayload(params: GnameTaskPayloadInput): SkyvernTaskPayload {
	const definition = GNAME_PROVIDER;
	if (!gnameDefinitionHasValidHash(definition)) throw new Error("GNAME provider definition hash is invalid.");
	if (!gnamePinnedEntryUrl(params.entryUrl, definition)) throw new Error("GNAME task entry URL is not the pinned provider URL.");
	if (typeof params.description !== "string" || params.description.length > 1_000) throw new Error("GNAME description exceeds the provider limit.");
	if (!hasValidGnameDomains(params.domains)) throw new Error("GNAME task domains are missing or invalid.");
	if (!hasBoundedStringList(params.observedUrls, 100)) throw new Error("GNAME task observed URLs are missing or invalid.");
	if (typeof params.serviceName !== "string" || !params.serviceName.trim() || params.serviceName.length > 500) throw new Error("GNAME service name is invalid.");
	if (typeof params.legalBrandUrl !== "string" || !params.legalBrandUrl || params.legalBrandUrl.length > 4_096) throw new Error("GNAME legal brand URL is invalid.");
	if (typeof params.serviceMailbox !== "string" || !params.serviceMailbox.includes("@") || params.serviceMailbox.length > 320) throw new Error("GNAME service mailbox is invalid.");
	if (
		!hasBoundedStringList(params.presignedEvidenceUrls, definition.evidence.maximumImages)
		|| params.presignedEvidenceUrls.some((url) => !isSafeSkyvernStorageUrl(url))
	) {
		throw new Error("GNAME task evidence URLs are missing or unsafe.");
	}
	return {
		url: definition.entryUrl,
		prompt: [
			"Use only the pinned GNAME category-2 abuse form.",
			"Select category 8, Set up phishing and fraud site.",
			`Submit exactly these domains: ${JSON.stringify(params.domains)}.`,
			`Submit exactly these observed URLs: ${JSON.stringify(params.observedUrls)}.`,
			`Use this exact provider description: ${JSON.stringify(params.description)}.`,
			`Use service identity ${JSON.stringify(params.serviceName)}, legal brand URL ${JSON.stringify(params.legalBrandUrl)}, mailbox ${JSON.stringify(params.serviceMailbox)}.`,
			`Upload only these SDK presigned URLs: ${JSON.stringify(params.presignedEvidenceUrls)}.`,
			"Verify all semantic landmarks and extracted output. If any required field, declaration, origin, or final submit control drifts, stop without submitting and return form_drift=true.",
		].join("\n"),
		max_steps: Number(process.env.ABUSE_SKYVERN_MAX_STEPS ?? 120),
		data_extraction_schema: definition.extractionSchema,
		webhook_url: params.webhookUrl,
		totp_identifier: params.totpIdentifier,
		engine: "skyvern-2.0",
		include_action_history_in_verification: true,
	};
}

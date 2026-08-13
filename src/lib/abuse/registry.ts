import { hashStableJson, normalizeDomain, registrableDomain } from "./security";

export type ProviderDefinition = {
	key: string;
	displayName: string;
	version: string;
	contentHash: string;
	routeType: "skyvern_portal";
	entryUrl: string;
	verifiedDomains: string[];
	allowedReplyLinkDomains: string[];
	registrarIds: number[];
	requiredSemanticLandmarks: string[];
	requiredFields: string[];
	evidence: {
		acceptedMimeTypes: Array<"image/jpeg" | "image/png">;
		maximumImages: number;
		maximumBytesPerImage: number;
	};
	identityPolicy: "verified_service_identity";
	captchaPolicy: "dbc_extension";
	emailCodePolicy: "shared_mailbox_serialized";
	extractionSchema: Record<string, unknown>;
	escalation: { allowExplicitUnmonitoredReplyLink: boolean };
};

/**
 * The generic adapter is deliberately a single code-owned contract rather
 * than a provider-specific form scraper. It can only be entered after an
 * explicit monitored-mailbox reply yields a URL within that route's verified
 * provider domain; callers cannot inject selectors, prompts, or destinations.
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

/** Exact accredited GNAME registrar IDs reviewed against IANA's registrar XML. */
export const GNAME_REGISTRAR_IDS = Object.freeze([
	1923,
	...range(3941, 3950),
	...range(3980, 4019),
	...range(4043, 4142),
	...range(4164, 4312),
	...range(4343, 4542),
]);

function range(start: number, end: number): number[] {
	return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

const gnameDefinitionWithoutHash = {
	key: "gname",
	displayName: "GNAME",
	version: "2026-08-13.3",
	routeType: "skyvern_portal" as const,
	entryUrl: "https://www.gname.com/abuse/category/2",
	verifiedDomains: ["gname.com"],
	allowedReplyLinkDomains: ["gname.com"],
	registrarIds: [...GNAME_REGISTRAR_IDS],
	requiredSemanticLandmarks: [
		"GNAME abuse category 2 entry page",
		"category 8 Set up phishing and fraud site",
		"domain and observed-URL inputs",
		"evidence upload control",
		"email verification-code request",
		"declaration acknowledgement",
		"final submit control",
	],
	requiredFields: ["category", "domains", "observedUrls", "description", "screenshots", "serviceName", "legalBrandUrl", "serviceMailbox", "declaration"],
	evidence: {
		acceptedMimeTypes: ["image/jpeg", "image/png"] as Array<"image/jpeg" | "image/png">,
		maximumImages: 15,
		maximumBytesPerImage: 2 * 1024 * 1024,
	},
	identityPolicy: "verified_service_identity" as const,
	captchaPolicy: "dbc_extension" as const,
	emailCodePolicy: "shared_mailbox_serialized" as const,
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
				declaration_checked: { type: "boolean" },
				declaration_contract: { type: "string", enum: ["gname_service_declaration_v1"] },
				irreversible_actions: { type: "array", items: { type: "string", enum: ["provider_report_submit"] }, maxItems: 1 },
			},
			required: ["form_contract_passed", "confirmation_text", "final_url", "submitted_domains", "submitted_urls", "provider_errors", "form_drift", "final_submit_clicked", "final_submit_control", "declaration_checked", "declaration_contract", "irreversible_actions"],
	},
	escalation: { allowExplicitUnmonitoredReplyLink: true },
};

const genericProviderFormDefinitionWithoutHash = {
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

export const GNAME_PROVIDER: ProviderDefinition = Object.freeze({
	...gnameDefinitionWithoutHash,
	contentHash: hashStableJson(gnameDefinitionWithoutHash),
});

export const GENERIC_PROVIDER_FORM_ADAPTER: GenericProviderFormDefinition = Object.freeze({
	...genericProviderFormDefinitionWithoutHash,
	contentHash: hashStableJson(genericProviderFormDefinitionWithoutHash),
});

const providerDefinitions = [GNAME_PROVIDER] as const;

export function listProviderDefinitions(): readonly ProviderDefinition[] {
	return providerDefinitions;
}

export function getProviderDefinition(key: string): ProviderDefinition | undefined {
	return providerDefinitions.find((definition) => definition.key === key);
}

export function genericProviderFormAdapterHasValidHash(definition: GenericProviderFormDefinition = GENERIC_PROVIDER_FORM_ADAPTER): boolean {
	const { contentHash, ...withoutHash } = definition;
	return contentHash === hashStableJson(withoutHash);
}

/** Verifies code-owned registry contents before every irreversible portal action. */
export function providerDefinitionHasValidHash(definition: ProviderDefinition): boolean {
	const { contentHash, ...withoutHash } = definition;
	return contentHash === hashStableJson(withoutHash);
}

/** Exact IANA registrar-ID matching only; display names are intentionally ignored. */
export function getProviderForRegistrarId(registrarId: number | undefined): ProviderDefinition | undefined {
	if (!registrarId || !Number.isInteger(registrarId)) return undefined;
	return providerDefinitions.find((definition) => definition.registrarIds.includes(registrarId));
}

export function isProviderRouteEnabled(definition: ProviderDefinition): boolean {
	if (process.env[`ABUSE_PROVIDER_${definition.key.toUpperCase()}_DISABLED`] === "true") return false;
	if (definition.key === "gname") return process.env.ABUSE_GNAME_ENABLED === "true";
	return false;
}

/** Rollout gates are code-owned; SMTP configuration alone never enables a route. */
export function isGenericEmailRouteEnabled(): boolean {
	return process.env.ABUSE_GENERIC_EMAIL_ENABLED === "true";
}

/** Generic provider-form escalation is a separate, independently switchable gate. */
export function isGenericFormEscalationEnabled(): boolean {
	return process.env.ABUSE_GENERIC_FORM_ESCALATION_ENABLED === "true";
}

export function gnameServiceIdentity(): { name: string; mailbox: string; verified: boolean } {
	const name = process.env.ABUSE_GNAME_SERVICE_NAME?.trim() ?? "Phishing Support";
	const mailbox = process.env.ABUSE_GNAME_SERVICE_MAILBOX?.trim().toLowerCase() ?? "";
	return {
		name,
		mailbox,
		verified: process.env.ABUSE_GNAME_IDENTITY_VERIFIED === "true" && Boolean(mailbox),
	};
}

export function isProviderOriginAllowed(definition: ProviderDefinition, url: URL): boolean {
	if (url.protocol !== "https:") return false;
	const host = normalizeDomain(url.hostname);
	if (!host) return false;
	return definition.verifiedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function providerDefinitionMatchesPin(definition: ProviderDefinition, version: string | null | undefined, contentHash: string | null | undefined): boolean {
	return providerDefinitionHasValidHash(definition) && version === definition.version && contentHash === definition.contentHash;
}

/**
 * A reply link is only eligible if it remains inside the provider's reviewed
 * registrable-domain boundary. This is separate from arbitrary user input.
 */
export function isProviderReplyLinkAllowed(definition: ProviderDefinition, url: URL): boolean {
	if (url.protocol !== "https:") return false;
	const host = normalizeDomain(url.hostname);
	if (!host) return false;
	return definition.allowedReplyLinkDomains.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** Validates an explicit email-route link against only its verified domains. */
export function isVerifiedEmailRouteOriginAllowed(verifiedDomains: string[], url: URL): boolean {
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
	const host = normalizeDomain(url.hostname);
	if (!host) return false;
	return verifiedDomains.some((domain) => {
		const normalized = normalizeDomain(domain);
		return Boolean(normalized && (host === normalized || host.endsWith(`.${normalized}`)));
	});
}

/** For an explicit abuse mailbox, its registrable provider domain is the verified web boundary. */
export function verifiedDomainsForEmailRoute(email: string): string[] {
	const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
	const root = registrableDomain(domain);
	return root ? [root] : [];
}

export function extractIanaRegistrarId(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value !== "string") return undefined;
	const matched = value.trim().match(/^(?:IANA(?:\s+Registrar)?(?:\s+ID)?\s*[:#-]?\s*)?(\d{1,8})$/i);
	if (!matched) return undefined;
	const id = Number(matched[1]);
	return Number.isSafeInteger(id) ? id : undefined;
}

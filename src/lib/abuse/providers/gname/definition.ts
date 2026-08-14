import { hashStableJson } from "../../security";
import type { PortalProviderDefinition } from "../contracts";

export type GnameDefinition = PortalProviderDefinition
	& {
		entryUrl: string;
		requiredSemanticLandmarks: readonly string[];
		requiredFields: readonly string[];
		evidence: {
			acceptedMimeTypes: readonly ("image/jpeg" | "image/png")[];
			maximumImages: number;
			maximumBytesPerImage: number;
		};
		identityPolicy: "verified_service_identity";
		captchaPolicy: "dbc_extension";
		emailCodePolicy: "shared_mailbox_serialized";
		extractionSchema: Record<string, unknown>;
	};

/** Exact accredited GNAME registrar IDs reviewed against IANA registrar data. */
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

const definitionWithoutHash = {
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
		acceptedMimeTypes: ["image/jpeg", "image/png"] as const,
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

export const GNAME_PROVIDER: GnameDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});

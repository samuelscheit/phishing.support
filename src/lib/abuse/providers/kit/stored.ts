import { z } from "zod";

import { normalizeDomain, normalizePublicHttpUrl } from "../../security/security";
import { storedProviderEvidenceImageReference, type ProviderEvidenceImageContract, type ProviderEvidenceImageMimeType, type ProviderEvidenceImageReference } from "./evidence";
import { isReportReference } from "./report_reference";

/**
 * `{adapter, definition: {version, contentHash}}` as
 * every stored draft carries it: `shape` goes into the reader's schema,
 * `stamp` into the builder's payload, so both agree by construction.
 */
export function payloadEnvelope<const A extends string>(definition: { version: string; contentHash: string }, adapter: A) {
	return {
		shape: {
			adapter: z.literal(adapter),
			definition: z.object({ version: z.string(), contentHash: z.string() })
				.refine((stamped) => stamped.version === definition.version && stamped.contentHash === definition.contentHash),
		},
		stamp: {
			adapter,
			definition: { version: definition.version, contentHash: definition.contentHash },
		},
	};
}

/**
 * Field schemas that mirror the builders' own normalisation: a stored value is
 * valid exactly when a builder could have written it.
 */
export const field = {
	domain: z.string().refine((value) => normalizeDomain(value) === value),
	reference: z.string().refine((value) => isReportReference(value)),
	/** Non-empty text of at most `maximum` characters. */
	text: (maximum: number) => z.string().min(1).max(maximum),
	/** A public http(s) URL as `normalizePublicHttpUrl` writes it, without whitespace. */
	url: (maximum: number, minimum = 1, forbidden = /\s/) => z.string().min(minimum).max(maximum).refine((value) => !forbidden.test(value) && normalizePublicHttpUrl(value) === value),
	/** A brand site as `normalizePublicHttpUrl(…, { domainOnly: true })` writes it. */
	brandUrl: z.string().refine((value) => normalizePublicHttpUrl(value, { domainOnly: true }) === value),
	evidence: <M extends ProviderEvidenceImageMimeType>(contract: ProviderEvidenceImageContract<M>) =>
		z.custom<ProviderEvidenceImageReference<M>>((value) => storedProviderEvidenceImageReference(value, contract) !== undefined),
};

/** Free text whose first line is our reference, so the provider's mail quotes it. */
export function leadsWithReference(text: string, trackingId: string): boolean {
	return text.startsWith(`Reference: ${trackingId}\n`);
}

/** `(value: unknown) => Payload | undefined`: unknown keys are stripped, any violated field rejects the whole draft. */
export function storedReader<S extends z.ZodType>(schema: S): (value: unknown) => z.output<S> | undefined {
	return (value) => {
		const parsed = schema.safeParse(value);
		return parsed.success ? parsed.data : undefined;
	};
}

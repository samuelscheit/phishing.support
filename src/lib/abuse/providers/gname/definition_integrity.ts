import { exactAllowedHttpsUrl } from "../../skyvern/provider_contract";
import { providerDefinitionHasValidHash, providerDefinitionMatchesPin } from "../definition";
import { GNAME_PROVIDER, type GnameDefinition } from "./definition";

/**
 * Verify the reviewed GNAME form definition before an irreversible action.
 * This intentionally lives beside the concrete definition so GNAME code never
 * reaches back through the provider registry that registers it.
 */
export function gnameDefinitionHasValidHash(definition: GnameDefinition = GNAME_PROVIDER): boolean {
	return providerDefinitionHasValidHash(definition);
}

export function gnameDefinitionMatchesPin(
	definition: GnameDefinition,
	version: string | null | undefined,
	contentHash: string | null | undefined,
): boolean {
	return providerDefinitionMatchesPin(definition, version, contentHash);
}

/**
 * Parse the one reviewed GNAME form URL. A provider payload must not be able
 * to turn a valid GNAME domain allowlist into permission to start at another
 * page on that origin.
 */
export function gnamePinnedEntryUrl(value: unknown, definition: GnameDefinition = GNAME_PROVIDER): URL | undefined {
	if (!gnameDefinitionHasValidHash(definition)) return undefined;
	const entryUrl = exactAllowedHttpsUrl(value, [...definition.verifiedDomains]);
	return entryUrl?.toString() === definition.entryUrl ? entryUrl : undefined;
}

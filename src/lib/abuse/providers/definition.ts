import { hashStableJson } from "../security";

/** Verifies code-owned provider definitions before an irreversible action. */
export function providerDefinitionHasValidHash(definition: { contentHash: string }): boolean {
	const { contentHash, ...withoutHash } = definition;
	return contentHash === hashStableJson(withoutHash);
}

export function providerDefinitionMatchesPin(
	definition: { version: string; contentHash: string },
	version: string | null | undefined,
	contentHash: string | null | undefined,
): boolean {
	return providerDefinitionHasValidHash(definition) && version === definition.version && contentHash === definition.contentHash;
}

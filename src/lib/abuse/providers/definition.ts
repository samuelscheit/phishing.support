import { hashStableJson, normalizeDomain } from "../security";

import type { PortalProviderDefinition } from "./contracts";

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

/** A provider-declared reply link remains inside its reviewed web boundary. */
export function isProviderReplyLinkAllowed(definition: PortalProviderDefinition, url: URL): boolean {
	if (url.protocol !== "https:") return false;
	const host = normalizeDomain(url.hostname);
	if (!host) return false;
	return definition.allowedReplyLinkDomains.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

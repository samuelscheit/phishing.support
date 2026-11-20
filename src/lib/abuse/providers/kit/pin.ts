import { serviceIdentity } from "../../../network/service_identity";
import { hashStableJson } from "../../security";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

/** The reporter every provider form is filed under. */
export const serviceReporter = { name: serviceIdentity.name, email: serviceIdentity.mailbox } as const;

/**
 * Freeze a code-owned definition and stamp the hash of its reviewed content.
 * A changed literal changes the hash, which sends routes pinned to the old
 * one to a person: bump `version` together with any change.
 */
export function definePinned<const T extends Omit<ProviderSubmissionDefinition, "contentHash">>(definition: T): Readonly<T & { contentHash: string }> {
	return Object.freeze({ ...definition, contentHash: hashStableJson(definition) });
}

/** Verifies a code-owned definition before an irreversible action. */
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

/** The route belongs to this provider and was created under this exact pinned definition. */
export function routeIsOurs(
	definition: ProviderSubmissionDefinition,
	route: { routeType: string; providerRegistryKey: string | null; providerDefinitionVersion: string | null; providerDefinitionHash: string | null },
): boolean {
	return route.routeType === "provider_submission" && route.providerRegistryKey === definition.key
		&& providerDefinitionMatchesPin(definition, route.providerDefinitionVersion, route.providerDefinitionHash);
}

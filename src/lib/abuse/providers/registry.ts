import { gnameProvider } from "./gname";
import type { PortalProvider, PortalProviderDefinition } from "./contracts";
import {
	isProviderReplyLinkAllowed,
	providerDefinitionHasValidHash,
	providerDefinitionMatchesPin,
} from "./definition";

export type PortalProviderRegistry = {
	list(): readonly PortalProvider[];
	get(key: string): PortalProvider | undefined;
	getForRegistrarId(registrarId: number | undefined): PortalProvider | undefined;
};

/**
 * Build the static provider registry once. Duplicate IANA registrar IDs are
 * a programming error: selecting the first matching provider would silently
 * route a report to the wrong irreversible workflow.
 */
export function createPortalProviderRegistry(providers: readonly PortalProvider[]): PortalProviderRegistry {
	const byKey = new Map<string, PortalProvider>();
	const byRegistrarId = new Map<number, PortalProvider>();
	for (const provider of providers) {
		if (byKey.has(provider.definition.key)) throw new Error(`Duplicate abuse provider key ${provider.definition.key}.`);
		byKey.set(provider.definition.key, provider);
		for (const registrarId of provider.definition.registrarIds) {
			if (!Number.isSafeInteger(registrarId) || registrarId <= 0) throw new Error(`Invalid registrar ID for ${provider.definition.key}.`);
			const existing = byRegistrarId.get(registrarId);
			if (existing) throw new Error(`Registrar ID ${registrarId} is registered by both ${existing.definition.key} and ${provider.definition.key}.`);
			byRegistrarId.set(registrarId, provider);
		}
	}
	return {
		list: () => providers,
		get: (key) => byKey.get(key),
		getForRegistrarId: (registrarId) => registrarId !== undefined && Number.isInteger(registrarId) ? byRegistrarId.get(registrarId) : undefined,
	};
}

const registry = createPortalProviderRegistry([gnameProvider]);

export function listPortalProviders(): readonly PortalProvider[] {
	return registry.list();
}

export function getPortalProvider(key: string): PortalProvider | undefined {
	return registry.get(key);
}

export function getPortalProviderForRegistrarId(registrarId: number | undefined): PortalProvider | undefined {
	return registry.getForRegistrarId(registrarId);
}

export function getProviderDefinition(key: string): PortalProviderDefinition | undefined {
	return getPortalProvider(key)?.definition;
}

export {
	isProviderReplyLinkAllowed,
	providerDefinitionHasValidHash,
	providerDefinitionMatchesPin,
};

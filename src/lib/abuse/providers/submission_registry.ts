import type { ProviderSubmissionProvider } from "./submission_contracts";
import { providerDefinitionHasValidHash } from "./definition";

export type ProviderSubmissionRegistry = {
	list(): readonly ProviderSubmissionProvider[];
	get(key: string): ProviderSubmissionProvider | undefined;
	getForMailbox(mailbox: string | undefined): ProviderSubmissionProvider | undefined;
	listSupplemental(): readonly ProviderSubmissionProvider[];
	listSupplementalForTarget(target: { targetType: "domain" | "ip"; observedUrls: readonly string[] }): readonly ProviderSubmissionProvider[];
};

/**
 * Canonicalize a provider-declared mailbox for exact matching. Definitions are
 * code-owned, so this deliberately accepts only a plain mailbox rather than
 * display-name or header syntax.
 */
function normalizeExactMailbox(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const mailbox = value.trim().toLowerCase();
	if (mailbox.length > 320 || /[\r\n\0]/.test(mailbox)) return undefined;
	return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(mailbox)
		? mailbox
		: undefined;
}

/**
 * Compose direct-submission providers without coupling generic routing to any
 * concrete implementation. Duplicate mailbox ownership is rejected before an
 * irreversible request can be routed ambiguously.
 */
export function createProviderSubmissionRegistry(providers: readonly ProviderSubmissionProvider[]): ProviderSubmissionRegistry {
	const registeredProviders = [...providers] as readonly ProviderSubmissionProvider[];
	const byKey = new Map<string, ProviderSubmissionProvider>();
	const byMailbox = new Map<string, ProviderSubmissionProvider>();

	for (const provider of registeredProviders) {
		const { definition } = provider;
		if (byKey.has(definition.key)) throw new Error(`Duplicate provider submission key ${definition.key}.`);
		if (!providerDefinitionHasValidHash(definition)) throw new Error(`Provider submission ${definition.key} has an invalid content hash.`);
		if (!Array.isArray(definition.exactMailboxes)) throw new Error(`Provider submission ${definition.key} must declare exact mailboxes as an array.`);
		if (!definition.supplemental && definition.exactMailboxes.length === 0) {
			throw new Error(`Provider submission ${definition.key} must declare an exact mailbox or be supplemental.`);
		}
		if (definition.supplemental && (!Array.isArray(definition.supplementalTargets) || definition.supplementalTargets.length === 0)) {
			throw new Error(`Supplemental provider submission ${definition.key} must declare at least one target rule.`);
		}
		for (const rule of definition.supplementalTargets ?? []) {
			if (rule.targetType !== "domain" && rule.targetType !== "ip") {
				throw new Error(`Supplemental provider submission ${definition.key} has an invalid target type.`);
			}
		}

		byKey.set(definition.key, provider);
		for (const declaredMailbox of definition.exactMailboxes) {
			const mailbox = normalizeExactMailbox(declaredMailbox);
			if (!mailbox) throw new Error(`Invalid exact mailbox for provider submission ${definition.key}.`);
			const existing = byMailbox.get(mailbox);
			if (existing) {
				throw new Error(`Exact mailbox ${mailbox} is registered by both ${existing.definition.key} and ${definition.key}.`);
			}
			byMailbox.set(mailbox, provider);
		}
	}

	const supplementalProviders = registeredProviders.filter((provider) => provider.definition.supplemental);
	return {
		list: () => registeredProviders,
		get: (key) => byKey.get(key),
		getForMailbox: (mailbox) => {
			const normalized = normalizeExactMailbox(mailbox);
			return normalized ? byMailbox.get(normalized) : undefined;
		},
		listSupplemental: () => supplementalProviders,
		listSupplementalForTarget: (target) => supplementalProviders.filter((provider) =>
			provider.definition.supplementalTargets!.some((rule) =>
				rule.targetType === target.targetType && (!rule.requiresObservedUrl || target.observedUrls.length > 0),
			),
		),
	};
}

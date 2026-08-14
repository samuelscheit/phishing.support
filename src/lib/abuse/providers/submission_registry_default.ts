import { cloudflareProvider } from "./cloudflare";
import { googleSafeBrowsingProvider } from "./google_safe_browsing";
import { createProviderSubmissionRegistry } from "./submission_registry";
import type { ProviderSubmissionProvider } from "./submission_contracts";
import { tencentProvider } from "./tencent";

/**
 * The one composition root for code-owned direct-submission providers. Generic
 * resolver and worker code dispatch only through the functions below; they do
 * not import or branch on a concrete provider.
 */
const registry = createProviderSubmissionRegistry([
	cloudflareProvider,
	tencentProvider,
	googleSafeBrowsingProvider,
]);

export function listProviderSubmissionProviders(): readonly ProviderSubmissionProvider[] {
	return registry.list();
}

export function getProviderSubmissionProvider(key: string): ProviderSubmissionProvider | undefined {
	return registry.get(key);
}

export function getProviderSubmissionProviderForMailbox(mailbox: string | undefined): ProviderSubmissionProvider | undefined {
	return registry.getForMailbox(mailbox);
}

export function listSupplementalProviderSubmissionProviders(): readonly ProviderSubmissionProvider[] {
	return registry.listSupplemental();
}

export function listSupplementalProviderSubmissionProvidersForTarget(target: {
	targetType: "domain" | "ip";
	observedUrls: readonly string[];
}): readonly ProviderSubmissionProvider[] {
	return registry.listSupplementalForTarget(target);
}

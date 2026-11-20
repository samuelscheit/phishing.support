import type { AbuseTargetType } from "../schema";
import { alibabaCloudProvider } from "./alibaba_cloud";
import { awsProvider } from "./aws";
import { cloudflareProvider } from "./cloudflare";
import { discordDsaProvider } from "./discord_dsa";
import { discordWebhookProvider } from "./discord_webhook";
import { dynadotProvider } from "./dynadot";
import { eranetProvider } from "./eranet";
import { gnameProvider } from "./gname";
import { goDaddyProvider } from "./godaddy";
import { googleCloudProvider } from "./google_cloud";
import { nameSiloProvider } from "./namesilo";
import { microsoftProvider } from "./microsoft";
import { nameComProvider } from "./name_com";
import { netcraftProvider } from "./netcraft";
import { netcraftMailProvider } from "./netcraft_mail";
import { createProviderSubmissionRegistry } from "./submission_registry";
import type { ProviderSubmissionProvider } from "./submission_contracts";
import { tencentProvider } from "./tencent";
import { newfoldProvider } from "./newfold";
import { publicDomainRegistryProvider } from "./publicdomainregistry";
import { tucowsProvider } from "./tucows";

/**
 * The one composition root for code-owned direct-submission providers. Generic
 * resolver and worker code dispatch only through the functions below; they do
 * not import or branch on a concrete provider.
 */
const registry = createProviderSubmissionRegistry([
	cloudflareProvider,
	tencentProvider,
	alibabaCloudProvider,
	awsProvider,
	microsoftProvider,
	nameSiloProvider,
	eranetProvider,
	gnameProvider,
	googleCloudProvider,
	netcraftProvider,
	netcraftMailProvider,
	discordWebhookProvider,
	discordDsaProvider,
	tucowsProvider,
	publicDomainRegistryProvider,
	newfoldProvider,
	goDaddyProvider,
	nameComProvider,
	dynadotProvider,
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

export function getProviderSubmissionProviderForRegistrarId(registrarId: number | undefined): ProviderSubmissionProvider | undefined {
	return registry.getForRegistrarId(registrarId);
}

export function listSupplementalProviderSubmissionProviders(): readonly ProviderSubmissionProvider[] {
	return registry.listSupplemental();
}

export function listSupplementalProviderSubmissionProvidersForTarget(target: {
	targetType: AbuseTargetType;
	observedUrls: readonly string[];
}): readonly ProviderSubmissionProvider[] {
	return registry.listSupplementalForTarget(target);
}

import { z } from "zod";

import { serviceIdentity } from "../../../network/service_identity";
import { asRecord } from "../../../util/values";
import { ProviderSubmissionNeedsHumanError } from "../submission_contracts";
import { payloadEnvelope, storedReader } from "../kit/stored";
import { DISCORD_DSA_PROVIDER } from "./definition";

const envelope = payloadEnvelope(DISCORD_DSA_PROVIDER, "discord_dsa_notice_v1");
const SNOWFLAKE = /^\d{17,20}$/;

/** The durable draft: what the notice says, the server it is about and the reporter the DSA requires it to name. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ normalizedTarget: z.string() }),
	report: z.object({
		serverId: z.string().regex(SNOWFLAKE),
		description: z.string().min(1).max(DISCORD_DSA_PROVIDER.form.maximumDescriptionLength),
		reporter: z.object({ name: z.string().min(1), country: z.string().min(1), email: z.string() }),
	}),
});

export type DiscordDsaPayload = z.infer<typeof payloadSchema>;
/** What one notice says: the server, why, and who files it. */
export type DiscordDsaReport = DiscordDsaPayload["report"];

export const storedDiscordDsaPayload = storedReader(payloadSchema);

/** The probe's record of the webhook: the kit's page, when, and the webhook's server and channel. */
export type WebhookEvidence = { pageUrl: string; observedAt: string; submissionId?: string; webhookId: string; guildId?: string; channelId?: string };

export function webhookEvidence(artifacts: ReadonlyArray<{ name: string; mimeType: string; blob: Buffer }>): WebhookEvidence | undefined {
	const artifact = artifacts.find((candidate) => candidate.name === "exfiltration-evidence.json" && candidate.mimeType === "application/json");
	if (!artifact) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(artifact.blob.toString("utf-8"));
	} catch {
		return undefined;
	}
	const evidence = asRecord(parsed);
	const discord = asRecord(asRecord(evidence?.backend)?.discord);
	if (typeof evidence?.pageUrl !== "string" || typeof evidence.observedAt !== "string" || typeof discord?.webhookId !== "string") return undefined;
	return {
		pageUrl: evidence.pageUrl,
		observedAt: evidence.observedAt,
		...(typeof evidence.submissionId === "string" ? { submissionId: evidence.submissionId } : {}),
		webhookId: discord.webhookId,
		...(typeof discord.guildId === "string" ? { guildId: discord.guildId } : {}),
		...(typeof discord.channelId === "string" ? { channelId: discord.channelId } : {}),
	};
}

/**
 * Why the server's content is illegal, in the form's 512 characters: the kit,
 * the webhook it sends visitors' data to, the controlled test that showed it,
 * the law it breaks, and the case holding the evidence. A long page URL
 * gives way to its host before anything else is cut.
 */
export function discordDsaDescription(evidence: WebhookEvidence, caseUrl: string | undefined): string {
	const { maximumDescriptionLength } = DISCORD_DSA_PROVIDER.form;
	const at = `${evidence.observedAt.slice(0, 16).replace("T", " ")} UTC`;
	const build = (page: string) => [
		`Credential phishing. ${page} sends the passwords and data visitors enter to Discord webhook ${evidence.webhookId}${evidence.channelId ? ` (channel ${evidence.channelId})` : ""} of this server.`,
		`Our controlled test with synthetic data on ${at} confirmed it.`,
		DISCORD_DSA_PROVIDER.legalBasis,
		...(caseUrl ? [`Evidence: ${caseUrl}`] : []),
	].join(" ");
	const full = build(evidence.pageUrl);
	return full.length <= maximumDescriptionLength ? full : build(new URL(evidence.pageUrl).hostname).slice(0, maximumDescriptionLength);
}

/** What the notice is built from; `reporter` is undefined while the environment names none. */
export type DiscordDsaInput = { evidence: WebhookEvidence | undefined; caseUrl: string | undefined; reporter: { name: string; country: string } | undefined; target: string };

/**
 * Why the notice cannot be drafted, or undefined. The DSA requires the notice
 * to name a real person (`DISCORD_DSA_REPORTER_NAME`, and an EU
 * `DISCORD_DSA_REPORTER_COUNTRY` as the form lists it); without one the route
 * waits for a person.
 */
export function discordDsaRefusal({ evidence, reporter, target }: DiscordDsaInput): string | undefined {
	if (!evidence || target !== `discord-webhook:${evidence.webhookId}`) return "discord_dsa_requires_the_probe_evidence";
	if (!evidence.guildId || !SNOWFLAKE.test(evidence.guildId)) return "discord_dsa_requires_the_webhook_server_id";
	if (!reporter) throw new ProviderSubmissionNeedsHumanError("Discord's DSA form needs the reporter's legal name and EU country: set DISCORD_DSA_REPORTER_NAME and DISCORD_DSA_REPORTER_COUNTRY.");
	return undefined;
}

export function buildDiscordDsaPayload({ evidence, caseUrl, reporter, target }: DiscordDsaInput): DiscordDsaPayload | undefined {
	if (!evidence?.guildId || !reporter) return undefined;
	return {
		...envelope.stamp,
		target: { normalizedTarget: target },
		report: { serverId: evidence.guildId, description: discordDsaDescription(evidence, caseUrl), reporter: { ...reporter, email: serviceIdentity.mailbox } },
	};
}

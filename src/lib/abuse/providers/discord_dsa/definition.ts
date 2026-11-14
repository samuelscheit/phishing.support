import { hashStableJson } from "../../security";
import { DISCORD_WEBHOOK_URL } from "../discord_webhook/definition";
import type { MailedCodeSpec } from "../mailed_code";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type DiscordDsaProviderDefinition = ProviderSubmissionDefinition & {
	reportUrl: string;
	codeMail: MailedCodeSpec;
	/** The form's own captions, in the order a report passes them. */
	form: {
		reportType: string;
		/** "Where is this happening?": the element of the server the report is about. */
		element: string;
		/** "Please select the option that best describes the illegal content". */
		category: string;
		/** "Please describe why this content is illegal in your local jurisdiction": its textarea's limit. */
		maximumDescriptionLength: number;
	};
	/** Why credential phishing is illegal where the reporter lives, as the description states it. */
	legalBasis: string;
};

/**
 * Code-owned contract for Discord's Digital Services Act notice form
 * (discord.com/report), read on 2026-11-14. Discord does not review mail to
 * abuse@discord.com ("We're unable to review email submissions"), and its
 * support portal has no report type; this form is its documented web channel
 * for illegal content. A report is verified by a key Discord mails to the
 * reporter, then names the server: the guild of the kit's webhook.
 */
const definitionWithoutHash = {
	key: "discord_dsa",
	displayName: "Discord Trust & Safety (DSA notice)",
	version: "2026-11-14.1",
	exactMailboxes: [],
	supplemental: true,
	supplementalTargets: [{ targetType: "service_account" as const, requiresObservedUrl: true, observedUrlPattern: DISCORD_WEBHOOK_URL.source }],
	reportUrl: "https://discord.com/report",
	codeMail: {
		provider: "Discord",
		senderDomains: ["discord.com"],
		// "Your one-time verification key is TPSD5P", from noreply@discord.com.
		subjectPattern: "verification key",
		codePattern: "verification key is ([A-Z0-9]{6})\\b",
		codeSource: "subject" as const,
		maxAgeMs: 10 * 60_000,
		waitMs: 3 * 60_000,
	},
	form: { reportType: "Report a Server", element: "Other", category: "Cybercrime", maximumDescriptionLength: 512 },
	legalBasis: "Stealing account credentials is computer fraud and data espionage (StGB §202a, §263a; EU Directive 2013/40/EU).",
};

export const DISCORD_DSA_PROVIDER: DiscordDsaProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});

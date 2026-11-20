import { serviceIdentity } from "../../../constants";
import { hashStableJson } from "../../security";
import type { MailedCodeSpec } from "../mailed_code";
import type { ProviderSubmissionDefinition } from "../submission_contracts";

export type TucowsProviderDefinition = ProviderSubmissionDefinition & {
	origin: string;
	/** The wizard's first page: `/report`, then `/report/otp`, `/report/types`, `/report/form`. */
	reportUrl: string;
	/** The Cloudflare Turnstile widget on the first step, solved through Death by Captcha. */
	captcha: { provider: "death_by_captcha"; type: 12; siteKey: string; pageUrl: string };
	/** The verification-code mail the first step sends. */
	codeMail: MailedCodeSpec;
	/** The wizard's category for phishing and pharming of a domain. */
	phishingCategoryId: string;
	evidence: {
		acceptedMimeTypes: readonly ["image/png", "image/jpeg"];
		maximumBytes: number;
		filenamePrefix: "tucows_report";
	};
	maximumDescriptionLength: number;
	narrativeMaximumLength: number;
	timeoutMs: number;
	reporter: { name: string; email: string; organization: string; role: "it_security" };
};

const MIB = 1024 * 1024;

/**
 * Code-owned contract for Tucows' abuse form (Bullwark), the channel of the
 * Tucows Family of Registrars (Tucows, Enom, Ascio, EPAG, OpenSRS), captured
 * on 2026-11-20 (docs/providers/tucows.md). The mailboxes domainabuse@tucows.com
 * and abuse@enom.com answer "not monitored". Identity is a name and an email
 * confirmed by a mailed code; a Turnstile token gates that first step.
 * IANA registrar IDs: 69 Tucows Domains Inc., 48 eNom.
 */
const definitionWithoutHash = {
	key: "tucows_bullwark",
	displayName: "Tucows Abuse Form",
	version: "2026-11-20.1",
	exactMailboxes: ["domainabuse@tucows.com", "abuse@enom.com"],
	registrarIds: [48, 69],
	supplemental: false,
	origin: "https://bullwark.tucows.com",
	reportUrl: "https://bullwark.tucows.com/report",
	captcha: {
		provider: "death_by_captcha" as const,
		type: 12 as const,
		siteKey: "0x4AAAAAADhWTmUwriZtddpv",
		pageUrl: "https://bullwark.tucows.com/report",
	},
	codeMail: {
		provider: "Tucows",
		// Sent from noreply@bullwark.tucows.com; a subdomain of tucows.com matches.
		senderDomains: ["tucows.com"],
		subjectPattern: "verification code",
		// Six digits standing alone: not a "#364971" colour or part of a longer number.
		codePattern: "(?<![#\\w.])(\\d{6})(?![\\w.])",
		maxAgeMs: 10 * 60_000,
		waitMs: 3 * 60_000,
	},
	phishingCategoryId: "00731b3c-389e-4c7a-8df6-2c3718d4b2a9",
	evidence: {
		acceptedMimeTypes: ["image/png", "image/jpeg"] as const,
		maximumBytes: 10 * MIB,
		filenamePrefix: "tucows_report" as const,
	},
	maximumDescriptionLength: 6_000,
	narrativeMaximumLength: 3_000,
	timeoutMs: 45_000,
	reporter: { name: serviceIdentity.name, email: serviceIdentity.mailbox, organization: serviceIdentity.name, role: "it_security" as const },
};

export const TUCOWS_PROVIDER: TucowsProviderDefinition = Object.freeze({
	...definitionWithoutHash,
	contentHash: hashStableJson(definitionWithoutHash),
});

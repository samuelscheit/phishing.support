import { simpleParser } from "mailparser";

import { MailIngestEntity, SubmissionsEntity } from "@/lib/db/entities";
import { matchProviderReply, storeProviderReply } from "@/lib/abuse/reply_ingest";
import { normalizeMailbox } from "@/lib/abuse/mail/shared";
import { extractEmlsFromIncomingMessage } from "@/lib/mail_forwarded";
import { createEmailSubmissionFromEml, type EmailSubmissionOptions } from "@/lib/submissions/email";

import { headerStrings, isSeen, recipients, type FetchedMail } from "./rfc";
import { errorText } from "../error_text";

export type MailIngestConfig = {
	mailbox: string;
	uidValidity: number;
	/** Address that receives forwarded phishing mail for analysis. */
	intakeAddress: string;
};

export type IntakeSubmissionCreator = (emlContent: string, options: EmailSubmissionOptions) => Promise<bigint>;

export type MailIngestResult =
	| { disposition: "terminal"; route: "reply" | "intake" | "ignored"; reason: string; messageId?: bigint }
	| { disposition: "skipped"; route: "intake"; reason: "already_seen" }
	| { disposition: "retry"; reason: string };

async function ingestIntake(params: {
	parsed: Awaited<ReturnType<typeof simpleParser>>;
	config: MailIngestConfig;
	uid: number;
	createIntakeSubmission: IntakeSubmissionCreator;
}) {
	const sourcePrefix = `imap:${encodeURIComponent(params.config.mailbox)}:${params.config.uidValidity}:${params.uid}`;
	if (await SubmissionsEntity.findIdBySourcePrefix(sourcePrefix)) return;
	const emls = await extractEmlsFromIncomingMessage(params.parsed, params.config.intakeAddress);
	for (let index = 0; index < emls.length; index++) {
		await params.createIntakeSubmission(emls[index]!, {
			source: `${sourcePrefix}${emls.length > 1 ? `:att${index + 1}` : ""}`,
		});
	}
}

/**
 * Route one message from the monitored mailbox. Provider replies are matched
 * only through our own reply identities and Message-IDs (never sender or
 * subject); mail to the intake address becomes a submission; anything else is
 * ignored. Callers mark a message seen only after a terminal result.
 */
export async function ingestFetchedMail(
	message: FetchedMail,
	config: MailIngestConfig,
	dependencies: { createIntakeSubmission?: IntakeSubmissionCreator } = {},
): Promise<MailIngestResult> {
	const ledgerKey = { mailbox: config.mailbox, uidValidity: config.uidValidity, uid: message.uid };
	let rawMessageId: string | undefined;
	try {
		const existing = await MailIngestEntity.get(ledgerKey);
		if (existing?.terminal) return { disposition: "terminal", route: existing.route as "reply" | "intake" | "ignored", reason: "terminal_ledger_record" };

		const raw = message.source ? Buffer.from(message.source) : undefined;
		if (!raw?.byteLength) throw new Error("IMAP fetch did not include the RFC 5322 source.");
		const parsed = await simpleParser(raw, { skipTextToHtml: true });
		rawMessageId = headerStrings(parsed, "message-id")[0]?.trim() || parsed.messageId?.trim() || message.envelope?.messageId?.trim();
		const recipientAddresses = recipients(parsed, message);

		const reply = await matchProviderReply(parsed, recipientAddresses);
		if (reply.kind === "reply") {
			const stored = await storeProviderReply({
				route: reply.route,
				mailKind: reply.mailKind,
				...(reply.bouncedMessageIds ? { bouncedMessageIds: reply.bouncedMessageIds } : {}),
				parsed,
				raw,
				recipientAddresses,
				...ledgerKey,
			});
			await MailIngestEntity.recordTerminal({ ...ledgerKey, messageId: rawMessageId, route: "reply", reason: stored.reason });
			return { disposition: "terminal", route: "reply", reason: stored.reason, messageId: stored.messageId };
		}
		if (reply.kind === "provider_api") {
			await MailIngestEntity.recordTerminal({ ...ledgerKey, messageId: rawMessageId, route: "ignored", reason: "provider_api_correspondence" });
			return { disposition: "terminal", route: "ignored", reason: "provider_api_correspondence" };
		}
		if (reply.kind === "ambiguous") {
			await MailIngestEntity.recordTerminal({ ...ledgerKey, messageId: rawMessageId, route: "ignored", reason: "ambiguous_report_correlation" });
			return { disposition: "terminal", route: "ignored", reason: "ambiguous_report_correlation" };
		}

		if (recipientAddresses.includes(normalizeMailbox(config.intakeAddress) ?? config.intakeAddress)) {
			// Already-read intake mail was handled (or deliberately skipped) by a
			// person; never resubmit it. Replies above are processed regardless.
			if (isSeen(message.flags)) return { disposition: "skipped", route: "intake", reason: "already_seen" };
			await ingestIntake({ parsed, config, uid: message.uid, createIntakeSubmission: dependencies.createIntakeSubmission ?? createEmailSubmissionFromEml });
			await MailIngestEntity.recordTerminal({ ...ledgerKey, messageId: rawMessageId, route: "intake", reason: "processed_intake" });
			return { disposition: "terminal", route: "intake", reason: "processed_intake" };
		}

		await MailIngestEntity.recordTerminal({ ...ledgerKey, messageId: rawMessageId, route: "ignored", reason: "no_report_match" });
		return { disposition: "terminal", route: "ignored", reason: "no_report_match" };
	} catch (error) {
		const reason = errorText(error);
		try {
			await MailIngestEntity.recordFailure({ ...ledgerKey, messageId: rawMessageId, reason });
		} catch (ledgerError) {
			console.error(`Failed to record retryable IMAP ingest failure for UID ${message.uid}:`, ledgerError);
		}
		return { disposition: "retry", reason };
	}
}

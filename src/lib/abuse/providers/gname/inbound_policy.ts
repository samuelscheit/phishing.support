import { extractUnambiguousVerificationCode, normalizeMailbox } from "../../mail/shared";

import { gnameCodeSenderDomains } from "./config";

/** The persistence layer stores parsed sender mailboxes as one comma-delimited field. */
export function storedGnameSenderAddresses(value: string | null): string[] {
	return value?.split(",").map((address) => address.trim()).filter(Boolean) ?? [];
}

function senderDomain(address: string): string | undefined {
	const mailbox = normalizeMailbox(address);
	return mailbox?.slice(mailbox.lastIndexOf("@") + 1);
}

function isAllowedGnameCodeSender(addresses: readonly string[]): boolean {
	const allowed = gnameCodeSenderDomains();
	if (allowed.length === 0 || addresses.length !== 1) return false;
	const domain = senderDomain(addresses[0]!);
	return Boolean(domain && allowed.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`)));
}

/**
 * Accept a verification message only when all GNAME-specific mail policy
 * gates pass. The caller owns route correlation; this function deliberately
 * does not infer a mailbox or accept a code from an arbitrary destination.
 */
export function gnameVerificationCodeFromMessage(params: {
	senderAddresses: readonly string[];
	recipients: readonly string[];
	textBody: string;
	mailbox: string;
}): string | undefined {
	const mailbox = normalizeMailbox(params.mailbox);
	if (!mailbox || !params.recipients.some((recipient) => normalizeMailbox(recipient) === mailbox)) return undefined;
	if (!isAllowedGnameCodeSender(params.senderAddresses)) return undefined;
	return extractUnambiguousVerificationCode(params.textBody);
}

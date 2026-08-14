import type { ParsedMail } from "mailparser";

import { extractUnambiguousVerificationCode } from "../mail";
import { AbuseRepository } from "../repository";
import { gnameServiceIdentity } from "../registry";
import { flattenAddresses, normalizeMailbox } from "./rfc";

function configuredGnameCodeSenderDomains(): string[] {
	return (process.env.ABUSE_GNAME_CODE_SENDER_DOMAINS ?? "gname.com")
		.split(",")
		.map((value) => value.trim().toLowerCase().replace(/\.+$/, ""))
		.filter((value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value));
}

function senderIsAllowedGnameCodeSource(parsed: ParsedMail): boolean {
	const senderDomains = flattenAddresses(parsed.from)
		.map((entry) => normalizeMailbox(entry.address)?.split("@")[1])
		.filter((value): value is string => Boolean(value));
	const allowed = configuredGnameCodeSenderDomains();
	return senderDomains.some((domain) => allowed.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`)));
}

/**
 * GNAME uses a shared service mailbox rather than one unique reply address.
 * The route lock permits at most one waiting task, so an exact recipient,
 * approved sender domain, and a single code can be correlated without ever
 * guessing between concurrent portal runs.
 */
export async function routeSharedGnameCode(params: { parsed: ParsedMail; recipients: string[]; body: string }) {
	const mailbox = gnameServiceIdentity().mailbox;
	if (!mailbox || !params.recipients.includes(mailbox)) return undefined;
	if (!senderIsAllowedGnameCodeSource(params.parsed)) return undefined;
	if (!extractUnambiguousVerificationCode(params.body)) return undefined;
	return AbuseRepository.getWaitingCodeRoute();
}

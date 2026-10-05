import { normalizeMailbox } from "../../mail/shared";

export type GnameServiceIdentity = {
	name: string;
	mailbox: string;
	verified: boolean;
};

export function isGnameEnabled(): boolean {
	return process.env.ABUSE_GNAME_ENABLED === "true";
}

export function gnameServiceIdentity(): GnameServiceIdentity {
	const name = process.env.ABUSE_GNAME_SERVICE_NAME?.trim() ?? "Phishing Support";
	const mailbox = normalizeMailbox(process.env.ABUSE_GNAME_SERVICE_MAILBOX) ?? "";
	return {
		name,
		mailbox,
		verified: process.env.ABUSE_GNAME_IDENTITY_VERIFIED === "true" && Boolean(mailbox),
	};
}

export function gnameCodeSenderDomains(): string[] {
	return (process.env.ABUSE_GNAME_CODE_SENDER_DOMAINS ?? "gname.com")
		.split(",")
		.map((value) => value.trim().toLowerCase().replace(/\.+$/, ""))
		.filter((value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(value));
}

export function gnamePositiveInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

import type { AbuseImapConfig } from "./types";

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing env var: ${name}`);
	return value;
}

function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	return value === undefined ? fallback : ["1", "true", "yes"].includes(value.toLowerCase());
}

export function getAbuseImapConfig(): AbuseImapConfig | undefined {
	const required = ["ABUSE_IMAP_HOST", "ABUSE_IMAP_USER", "ABUSE_IMAP_PASS", "ABUSE_IMAP_MAILBOX"];
	if (required.some((name) => !process.env[name]?.trim())) return undefined;
	return {
		host: requiredEnv("ABUSE_IMAP_HOST"),
		port: envInt("ABUSE_IMAP_PORT", 993),
		secure: envBool("ABUSE_IMAP_SECURE", true),
		user: requiredEnv("ABUSE_IMAP_USER"),
		pass: requiredEnv("ABUSE_IMAP_PASS"),
		mailbox: requiredEnv("ABUSE_IMAP_MAILBOX"),
		processSeen: envBool("ABUSE_IMAP_PROCESS_SEEN", true),
	};
}

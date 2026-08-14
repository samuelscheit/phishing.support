import { normalizeMailbox } from "../../mail/shared";

const DEFAULT_REPORTER_EMAIL = "support@phishing.support";

/**
 * Netcraft requires a submission email even for anonymous/public API access.
 * This intentionally uses the service identity rather than disclosing an
 * optional reporter contact address to another independent recipient.
 */
export function netcraftReporterEmail(): string {
	const email = normalizeMailbox(process.env.ABUSE_NETCRAFT_REPORTER_EMAIL ?? DEFAULT_REPORTER_EMAIL);
	if (!email) throw new Error("ABUSE_NETCRAFT_REPORTER_EMAIL must be a valid mailbox.");
	return email;
}

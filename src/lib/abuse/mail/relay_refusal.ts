import { isIP } from "node:net";

import { serviceIdentity } from "../../constants";

/**
 * A delivery status notification whose refusing hop is inside our own mail
 * relay: its Remote-MTA is a loopback or private address, a filter in front
 * of the relay's outbound queue, not the recipient's server. iCloud's
 * outbound content filter answers this way (`Reporting-MTA: dns;
 * outbound.ms.icloud.com`, `Remote-MTA: dns; 127.0.0.1`, `550 5.7.1 [CS101]
 * Message rejected due to local policy`; 30 of 34 failed reports, 2026-10 to
 * 2026-11). The provider never saw the report, so its mailbox is not dead.
 */
export function isRelayRefusal(dsnText: string): boolean {
	// The stored notification text is flattened to one line, so the field is found anywhere in it.
	const remote = dsnText.match(/\bRemote-MTA:\s*dns;\s*\[?([^\s\]]+?)\]?(?=\s|$)/i)?.[1];
	if (!remote) return false;
	const address = remote.toLowerCase();
	if (address === "localhost") return true;
	const version = isIP(address);
	if (version === 4) {
		const [a, b] = address.split(".").map(Number) as [number, number];
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
	}
	if (version === 6) return address === "::1" || /^f[cd]/.test(address);
	return false;
}

const LIVE_URL = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/** The public page of a report: every report has one, a submission's redirects to its case. */
export function reportPageUrl(reportId: bigint): string {
	return `${serviceIdentity.url}/reports/${reportId.toString()}`;
}

/**
 * The report body for a second attempt after the relay refused the first:
 * every live address but our own becomes its bare host, and a closing note
 * points to the report's page for the full addresses. Defanging is no way
 * out: spam filters score obfuscated URLs and undo them before their
 * blocklist lookup (commit 2a6d7c6); a bare host is neither.
 */
export function bodyWithoutLiveUrls(body: string, reportId: bigint): string {
	const ours = new URL(serviceIdentity.url).hostname;
	let replaced = false;
	const text = body.replace(LIVE_URL, (match) => {
		let host: string;
		try {
			host = new URL(match).hostname;
		} catch {
			return match;
		}
		if (host === ours || host.endsWith(`.${ours}`)) return match;
		replaced = true;
		return host;
	});
	if (!replaced) return body;
	const note = `The full addresses are left out of this email because our mail relay refused it with them; they are listed on the report's page: ${reportPageUrl(reportId)}`;
	const signOff = text.lastIndexOf("\n\nRegards,");
	return signOff >= 0 ? `${text.slice(0, signOff)}\n\n${note}${text.slice(signOff)}` : `${text.trimEnd()}\n\n${note}\n`;
}

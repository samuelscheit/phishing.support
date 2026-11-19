import { isIP } from "node:net";

/**
 * A delivery status notification whose refusing hop is inside our own mail
 * relay: its Remote-MTA is a loopback or private address, a filter in front
 * of the relay's outbound queue, not the recipient's server. iCloud's
 * outbound content filter answered this way while it was our relay
 * (`Reporting-MTA: dns; outbound.ms.icloud.com`, `Remote-MTA: dns;
 * 127.0.0.1`, `550 5.7.1 [CS101] Message rejected due to local policy`; 50
 * refusals of reports carrying live phishing URLs, 2026-10 to 2026-11), which
 * is why reports now leave through our own relay (docker/mailer). The
 * provider never saw the report, so its mailbox is not dead.
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

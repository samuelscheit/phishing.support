import { serviceIdentity } from "../../network/service_identity";
import { networkLabel, type HostMove } from "../../liveness/moves";

/** "26 Nov 2026 21:30 UTC". */
function utc(at: string): string {
	const date = new Date(at);
	return `${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date)} ${date.toISOString().slice(11, 16)} UTC`;
}

const list = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** "malware distribution site", "phishing site". */
function siteKind(allegation: string): string {
	return allegation === "malware" ? "malware distribution site" : allegation === "phishing" ? "phishing site" : "reported site";
}

/** "AS43641 (Sollutium-NL SOLLUTIUM EU Sp z.o.o.)", or the CDN's name. */
function networkOf(network: HostMove["to"]): string {
	if (network.cdn) return network.asn !== undefined ? `${network.cdn} (AS${network.asn})` : network.cdn;
	if (network.asn === undefined) return networkLabel(network);
	return `AS${network.asn}${network.holder ? ` (${network.holder})` : ""}`;
}

/** What happened, in one sentence: where the site went, from where, and since when. */
function moveSentence(move: HostMove, domain: string, audience: "host" | "other"): string {
	const addresses = list(move.to.addresses);
	const where = `${addresses}, in ${audience === "host" ? "your network " : ""}${networkOf(move.to)}`;
	switch (move.kind) {
		case "left_cdn":
			return `${domain} no longer runs behind ${move.from.cdn}'s proxy: since ${utc(move.at)}, it resolves directly to ${where}, and that server serves the reported site itself.`;
		case "new_cdn":
			return `${domain} has moved behind ${move.to.cdn}: since ${utc(move.at)}, it resolves to ${where}, which serves the reported site.`;
		case "new_network":
			return `${domain} has moved from ${list(move.from.addresses)}, in ${networkOf(move.from)}, to ${where}, since ${utc(move.at)}, and the new server serves the reported site.`;
	}
}

/** The facts the check recorded, each one a reader can repeat. */
function moveFacts(move: HostMove, domain: string): string[] {
	const [ip] = move.to.addresses;
	const { certificate, server, kitFiles } = move.evidence;
	const filePath = kitFiles[0] ? new URL(kitFiles[0].url).pathname : "/";
	return [
		`- DNS: ${domain} resolves to ${list(move.to.addresses)} (checked ${utc(move.at)}; before: ${list(move.from.addresses)}, ${networkOf(move.from)}).`,
		...(certificate ? [`- TLS: ${ip}:443 presents a certificate for ${list(certificate.names.slice(0, 4))} issued by ${certificate.issuer}, valid ${certificate.notBefore.slice(0, 10)} to ${certificate.notAfter.slice(0, 10)}, SHA-256 fingerprint ${certificate.fingerprint256}.`] : []),
		...(server ? [`- HTTP: the server answers as "${server}".`] : []),
		`- Content: ${kitFiles.length === 1 ? "this file is" : "these files are"} byte-identical to what we captured when we reported the site:`,
		...kitFiles.map((file) => `  ${file.url} (SHA-256 ${file.sha256})`),
		...(ip && !move.to.cdn ? [
			"",
			"To check it yourself:",
			`  openssl s_client -connect ${ip}:443 -servername ${domain}`,
			`  curl -s --resolve ${domain}:443:${ip} https://${domain}${filePath} | sha256sum`,
		] : []),
	];
}

const SIGNATURE = ["Thank you,", serviceIdentity.name, serviceIdentity.mailbox, serviceIdentity.url];

export type MoveNoticeParams = {
	move: HostMove;
	domain: string;
	allegation: string;
	greeting: string;
	caseUrl?: string;
};

/** To the host the site now runs on, which we already reported it to: its own server serves it. */
export function hostMoveNotice(params: MoveNoticeParams): string {
	const { move, domain } = params;
	const target = move.to.cdn ? `the account that serves ${domain} through ${move.to.addresses[0]}` : `the service at ${move.to.addresses[0]}`;
	return [
		params.greeting,
		"",
		`Further to our report of the ${siteKind(params.allegation)} ${domain}: ${moveSentence(move, domain, "host")}`,
		"",
		`What we found:`,
		...moveFacts(move, domain),
		"",
		`Please suspend ${target} and preserve its data for law enforcement.`,
		...(params.caseUrl ? ["", `Evidence (screenshots, archived page, analysis): ${params.caseUrl}`] : []),
		"",
		...SIGNATURE,
	].join("\n");
}

/** To a CDN that acted on the site: the operator took the site off its network, around its block. */
export function cdnBypassNotice(params: MoveNoticeParams & { confirmationId: string; hostContact?: string }): string {
	const { move, domain } = params;
	return [
		params.greeting,
		"",
		`Regarding report ${params.confirmationId} (${domain}): you acted on the reported ${siteKind(params.allegation)}, and its operator has since bypassed that by taking the site off your network. ${moveSentence(move, domain, "other")} Visitors reach it without your interstitial.`,
		"",
		"What we found:",
		...moveFacts(move, domain),
		"",
		params.hostContact
			? `We have told the new host (${params.hostContact}). If you still provide DNS or other services for ${domain}, please act on them too.`
			: `If you still provide DNS or other services for ${domain}, please act on them too.`,
		...(params.caseUrl ? ["", `Evidence (screenshots, archived page, analysis): ${params.caseUrl}`] : []),
		"",
		...SIGNATURE,
	].join("\n");
}

/** To a registrar that has not acted: the domain still serves the reported content, now from another host. */
export function registrarMoveNotice(params: MoveNoticeParams): string {
	const { move, domain } = params;
	return [
		params.greeting,
		"",
		`Further to our report of the ${siteKind(params.allegation)} ${domain}: the domain is still in use. ${moveSentence(move, domain, "other")}`,
		"",
		"What we found:",
		...moveFacts(move, domain),
		"",
		`Moving the site between hosts keeps it online whatever each host does. Please suspend the domain ${domain}.`,
		...(params.caseUrl ? ["", `Evidence (screenshots, archived page, analysis): ${params.caseUrl}`] : []),
		"",
		...SIGNATURE,
	].join("\n");
}

/** The move as a file for a new host's report: what we found and how to repeat it. */
export function hostMoveEvidence(move: HostMove, domain: string): Buffer {
	return Buffer.from([
		`Hosting change of ${domain}`,
		`Observed: ${move.at}`,
		`From: ${list(move.from.addresses)}, ${networkOf(move.from)}`,
		`To: ${list(move.to.addresses)}, ${networkOf(move.to)}`,
		`Checked URL: ${move.evidence.url} (HTTP ${move.evidence.httpStatus ?? "no answer"})`,
		"",
		...moveFacts(move, domain),
		"",
	].join("\n"), "utf8");
}

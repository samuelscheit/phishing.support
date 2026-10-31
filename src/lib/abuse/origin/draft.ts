import { serviceIdentity } from "../../constants";
import type { AbuseProviderRoute, AbuseReport } from "../schema";
import { abuseCaseTag } from "../mail/correlation";
import type { AbuseEmailDraft } from "../mail/draft";
import { humanizeOrganization, recipientGreeting } from "../mail/shared";
import { readOriginHostSnapshot, type KitCollectedData, type OriginHostSnapshot } from "./snapshot";

/** Domains listed in the body; the attached evidence always has all of them. */
const MAX_DOMAINS_IN_BODY = 40;
/** Certificate/registration details shown per domain before deferring to the evidence file. */
const MAX_CERTIFICATES_IN_BODY = 10;

type Certificate = OriginHostSnapshot["servers"][number]["certificate"];

function line(value: string): string {
	return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function utc(value: string | undefined): string | undefined {
	const date = value ? new Date(value) : undefined;
	return date && !Number.isNaN(date.getTime()) ? `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` : undefined;
}

function issuerName(issuer: string): string {
	return line(issuer.match(/(?:^|,\s*)O=([^,]+)/)?.[1] ?? issuer.match(/(?:^|,\s*)CN=([^,]+)/)?.[1] ?? issuer);
}

function list(values: readonly string[]): string {
	return values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

const SENSITIVE_DATA: readonly KitCollectedData[] = ["password", "one-time 2FA codes", "authenticator codes", "backup codes", "payment card details", "identity details"];

function stolenData(kit: OriginHostSnapshot["kit"]): string {
	if (kit.phishingBasis === "malware_delivery") return "delivers malware to visitors";
	const sensitive = kit.collects.filter((item) => SENSITIVE_DATA.includes(item) && item !== "password");
	const subject = kit.phishingBasis === "payment_fraud" ? "payment details" : "account credentials";
	return `steals ${subject}${sensitive.length ? `, including ${list(sensitive)}` : ""}`;
}

function certificateLine(domain: string, certificate: Certificate, registeredAt: string | undefined): string[] {
	const issued = utc(certificate.notBefore);
	const registered = utc(registeredAt);
	return [
		`- ${domain}: ${issued ? `issued ${issued}` : "certificate"}${registered ? `, domain registered ${registered}` : ""}`,
		`  SHA-256 ${certificate.fingerprint256}`,
	];
}

function originIntro(snapshot: OriginHostSnapshot, domains: number): string[] {
	const servers = snapshot.servers;
	if (servers.length === 0) {
		return [
			`Cloudflare named you as the host of the phishing site ${snapshot.originalDomain}, which ${stolenData(snapshot.kit)}. Please find the service behind it, suspend it, and preserve its data for law enforcement.`,
		];
	}
	const subject = servers.length === 1 ? "A server in your network runs" : `${servers.length} servers in your network run`;
	return [
		`${subject} a phishing operation that ${stolenData(snapshot.kit)}. Please suspend ${servers.length === 1 ? "it" : "them"} and preserve ${servers.length === 1 ? "its" : "their"} data for law enforcement.`,
		"",
		servers.length === 1
			? `Server: ${servers[0]!.ip}${servers[0]!.prefix || servers[0]!.asn ? ` (${[servers[0]!.prefix, servers[0]!.asn ? `AS${servers[0]!.asn}` : undefined].filter(Boolean).join(", ")})` : ""}`
			: ["Servers:", ...servers.map((server) => `- ${server.ip}${server.prefix || server.asn ? ` (${[server.prefix, server.asn ? `AS${server.asn}` : undefined].filter(Boolean).join(", ")})` : ""}`)].join("\n"),
		"",
		`Phishing domain${domains === 1 ? "" : "s"} served from ${servers.length === 1 ? "it" : "them"}:`,
	];
}

function linkage(snapshot: OriginHostSnapshot): string[] {
	const [first] = snapshot.servers;
	if (!first) {
		const scanned = snapshot.scan.addressesScanned;
		return scanned
			? [`We asked ${scanned.toLocaleString("en-US")} public IPv4 addresses announced by your network${snapshot.networks.length ? ` (${snapshot.networks.map(({ asn }) => `AS${asn}`).join(", ")})` : ""} for ${snapshot.originalDomain}'s certificate; none presented it, so the site may run on a service outside those ranges.`]
			: [];
	}
	const issuers = [...new Set([first.certificate, ...snapshot.siblings.map(({ certificate }) => certificate)].map(({ issuer }) => issuerName(issuer)))];
	const shared = snapshot.servers.every(({ certificate }) => certificate.fingerprint256 === first.certificate.fingerprint256);
	const where = snapshot.servers.length === 1 ? `${first.ip}:443` : shared ? `each of these servers on port 443` : "these servers on port 443";
	const siblings = snapshot.siblings.slice(0, MAX_CERTIFICATES_IN_BODY - 1);
	const deferred = snapshot.siblings.length - siblings.length;
	return [
		`How the ${snapshot.servers.length === 1 ? "server is" : "servers are"} tied to ${snapshot.siblings.length ? "these domains" : "this domain"} (observed ${utc(snapshot.scan.completedAt)}): when asked for ${snapshot.siblings.length ? "each domain" : "the domain"} by name, ${where} presents a certificate for it from ${list(issuers)}:`,
		...certificateLine(snapshot.originalDomain, first.certificate, snapshot.originalDomainRegisteredAt),
		...siblings.flatMap((sibling) => certificateLine(sibling.domain, sibling.certificate, sibling.registeredAt)),
		...(deferred ? [`- the certificates of the other ${deferred} domains are in the attached evidence`] : []),
		...(shared ? [] : ["The other servers present certificates for the same domain; the attached evidence lists each fingerprint."]),
		`You can check this with: openssl s_client -connect ${first.ip}:443 -servername ${snapshot.originalDomain}`,
		`We found ${snapshot.servers.length === 1 ? "it" : "them"} by asking ${snapshot.scan.addressesScanned.toLocaleString("en-US")} public IPv4 addresses announced by ${snapshot.networks.map(({ asn }) => `AS${asn}`).join(", ") || "your network"} for this certificate.`,
	];
}

function kitSection(snapshot: OriginHostSnapshot): string[] {
	const { kit } = snapshot;
	const lines: string[] = [];
	const quote = kit.evidenceQuote ? ` The page reads: "${kit.evidenceQuote}"` : "";
	if (kit.phishingBasis === "malware_delivery") {
		lines.push(`What the kit does: it pushes visitors to download, install or run something.${quote}`);
	} else if (kit.collects.length) {
		lines.push(`What the kit does: it asks victims for their ${list(kit.collects)}.${quote}`);
	} else if (quote) {
		lines.push(`What the kit does:${quote}`);
	}
	if (kit.exfiltrationTargets.length) {
		lines.push(`In a controlled test with synthetic data, the kit sent what was typed to: ${kit.exfiltrationTargets.join(", ")}.`);
	}
	if (kit.phishingBasis !== "malware_delivery" && kit.collects.some((item) => SENSITIVE_DATA.includes(item))) {
		const holder = snapshot.servers.length === 0 ? "The hosting service" : snapshot.servers.length === 1 ? "The server" : "These servers";
		lines.push(`${holder} therefore ${snapshot.servers.length > 1 ? "hold" : "holds"} live victim ${kit.phishingBasis === "payment_fraud" ? "payment data" : "credentials"}.`);
	}
	return lines.length ? ["", ...lines] : [];
}

function cloudflareContext(snapshot: OriginHostSnapshot): string[] {
	const report = snapshot.cloudflareReportId ? ` (report ${snapshot.cloudflareReportId})` : "";
	const siblings = snapshot.siblings.length;
	return [
		"",
		`${snapshot.originalDomain} is behind Cloudflare. Cloudflare processed our phishing report${report} and named ${snapshot.recipient} as the host.${siblings ? ` The other ${siblings === 1 ? "domain serves" : `${siblings} domains serve`} byte-identical kit files (same SHA-256 on urlscan.io).` : ""}`,
	];
}

function evidence(snapshot: OriginHostSnapshot, caseUrl: string | undefined, attachmentNames: readonly string[]): string[] {
	const described = attachmentNames.map((name) => name === "origin-host-evidence.txt"
		? "the full certificate and network checks (origin-host-evidence.txt)"
		: /\.png$/i.test(name) ? `a screenshot of the phishing page (${name})` : name);
	return [
		"",
		...(caseUrl ? [`Evidence (screenshot, archived page, analysis): ${caseUrl}`] : []),
		...(described.length ? [`Attached: ${list(described)}.`] : []),
	];
}

function actions(snapshot: OriginHostSnapshot, domains: number): string[] {
	const servers = snapshot.servers.length;
	const victims = snapshot.kit.phishingBasis !== "malware_delivery" && snapshot.kit.collects.length
		? "; the stored data identifies victims who need to be warned"
		: "";
	return [
		"",
		"We ask you to:",
		servers
			? `1. Suspend the ${servers === 1 ? "server" : "servers"}${domains > 1 ? `, so ${domains === 2 ? "both" : `all ${domains}`} domains go offline at once` : ""}.`
			: `1. Identify and suspend the service hosting ${snapshot.originalDomain}.`,
		`2. Preserve the disk, logs, and customer and payment records for law enforcement${victims}.`,
		"3. Check the same customer's other services for the same kit.",
		"4. Confirm receipt and tell us what action you took.",
	];
}

export function createOriginHostEmailDraft(input: {
	report: Pick<AbuseReport, "id" | "submissionId">;
	route: Pick<AbuseProviderRoute, "resolutionSnapshot">;
	attachmentNames?: string[];
}): AbuseEmailDraft | undefined {
	const snapshot = readOriginHostSnapshot(input.route.resolutionSnapshot);
	if (!snapshot) return undefined;
	const providerLabel = humanizeOrganization(line(snapshot.providerLabel));
	const caseUrl = input.report.submissionId ? `${serviceIdentity.url}/submissions/${input.report.submissionId.toString()}` : undefined;
	const attachmentNames = [...new Set((input.attachmentNames ?? []).map(line).filter(Boolean))].slice(0, 15);
	const domains = [snapshot.originalDomain, ...snapshot.siblings.map(({ domain }) => domain)];
	const shownDomains = domains.slice(0, MAX_DOMAINS_IN_BODY);
	const hiddenDomains = domains.length - shownDomains.length;
	const body = [
		recipientGreeting(providerLabel),
		"",
		...originIntro(snapshot, domains.length),
		...(snapshot.servers.length
			? [
				...shownDomains.map((domain) => `- ${domain}${domain === snapshot.originalDomain ? " (behind Cloudflare)" : ""}`),
				...(hiddenDomains ? [`- and ${hiddenDomains} more, listed in the attached evidence`] : []),
				"",
			]
			: [""]),
		...linkage(snapshot),
		...kitSection(snapshot),
		...cloudflareContext(snapshot),
		...evidence(snapshot, caseUrl, attachmentNames),
		...actions(snapshot, domains.length),
		"",
		"Thank you,",
		serviceIdentity.name,
		serviceIdentity.mailbox,
		serviceIdentity.url,
	].join("\n").trim().slice(0, 20_000);
	const kitLabel = snapshot.kit.phishingBasis === "malware_delivery" ? "malware delivery kit" : snapshot.kit.phishingBasis === "payment_fraud" ? "payment phishing kit" : "credential phishing kit";
	const location = snapshot.servers.length === 1
		? `on ${snapshot.servers[0]!.ip}`
		: snapshot.servers.length
			? `on ${snapshot.servers.length} servers`
			: `for ${snapshot.originalDomain}`;
	const reportReference = snapshot.cloudflareReportId ? ` (Cloudflare report ${snapshot.cloudflareReportId})` : "";
	return {
		subject: `[${serviceIdentity.name}] [${abuseCaseTag(input.report.id)}] Phishing abuse: ${kitLabel} ${location}${reportReference}`,
		body,
		recipientLabel: providerLabel,
	};
}

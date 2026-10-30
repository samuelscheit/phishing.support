import { serviceIdentity } from "../../constants";
import { normalizePublicHttpUrl } from "../security";
import type { AbuseProviderRoute, AbuseReport, AbuseTarget } from "../schema";
import { abuseCaseTag } from "../mail/correlation";
import type { AbuseEmailDraft } from "../mail/draft";
import { readOriginHostSnapshot } from "./snapshot";

function line(value: string): string {
	return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

export function createOriginHostEmailDraft(input: {
	report: Pick<AbuseReport, "id" | "submissionId">;
	target: Pick<AbuseTarget, "normalizedTarget" | "observedUrls">;
	route: Pick<AbuseProviderRoute, "resolutionSnapshot">;
	attachmentNames?: string[];
}): AbuseEmailDraft | undefined {
	const snapshot = readOriginHostSnapshot(input.route.resolutionSnapshot);
	if (!snapshot) return undefined;
	const providerLabel = line(snapshot.providerLabel) || snapshot.recipient.split("@")[1]!;
	const greeting = /\babuse\s+(?:team|desk|contact)\b/i.test(providerLabel)
		? `Hello ${providerLabel},`
		: `Hello ${providerLabel} Abuse Team,`;
	const caseUrl = input.report.submissionId ? `${serviceIdentity.url}/submissions/${input.report.submissionId.toString()}` : undefined;
	const observedUrls = [...new Set(input.target.observedUrls.map((url) => normalizePublicHttpUrl(url)).filter((url): url is string => Boolean(url)))].slice(0, 20);
	const servers = snapshot.servers.length
		? snapshot.servers.map((server) => {
			const network = [server.asn ? `AS${server.asn}` : undefined, server.prefix].filter(Boolean).join(", ");
			return `- ${server.ip}${network ? ` (${network})` : ""}: certificate ${server.certificate.fingerprint256}, valid ${server.certificate.notBefore} to ${server.certificate.notAfter}`;
		}).join("\n")
		: "- No origin IP was proven within the bounded scan; Cloudflare nevertheless explicitly named this mailbox as the hosting-provider contact.";
	const siblings = snapshot.siblings.length
		? snapshot.siblings.map((sibling) => `- ${sibling.domain} (same captured kit bytes; certificate presented by ${sibling.originIp})`).join("\n")
		: "- No additional domain was confirmed on the discovered origin server.";
	const attachments = [...new Set((input.attachmentNames ?? []).map(line).filter(Boolean))].slice(0, 15);
	const scan = snapshot.scan.totalAddresses
		? `The TLS-only sweep checked ${snapshot.scan.addressesScanned.toLocaleString("en-US")} of ${snapshot.scan.totalAddresses.toLocaleString("en-US")} public IPv4 addresses announced by registry-validated ASNs${snapshot.scan.truncated ? " (capped at 65,536 addresses)" : ""}.`
		: "No registry-validated IPv4 prefix was available for a TLS sweep.";
	const cloudflare = snapshot.cloudflareReportId ? ` Cloudflare report ${snapshot.cloudflareReportId} supplied the hosting contact.` : " Cloudflare supplied the hosting contact in its report response.";
	const body = [
		greeting,
		"",
		`Cloudflare identified ${snapshot.recipient} as the hosting-provider abuse contact for the confirmed phishing site ${snapshot.originalDomain}.${cloudflare}`,
		"",
		`Original phishing domain: ${snapshot.originalDomain}`,
		...(observedUrls.length ? ["Observed URLs:", ...observedUrls.map((url) => `- ${url}`)] : []),
		...(caseUrl ? [`Case details and screenshot: ${caseUrl}`] : []),
		"",
		"Origin-server evidence:",
		servers,
		scan,
		"",
		"Other domains confirmed on the same origin:",
		siblings,
		"",
		attachments.length ? `Attached evidence: ${attachments.join(", ")}.` : "The case link contains the captured evidence.",
		"Please suspend the relevant server or account, preserve its logs and customer records for investigation, check the same account for related phishing domains, and reply with the action taken.",
		"",
		"Regards,",
		`The ${serviceIdentity.name} team`,
	].join("\n").slice(0, 5_000).trim();
	return {
		subject: `[${serviceIdentity.name}] [${abuseCaseTag(input.report.id)}] Origin-host phishing report for ${snapshot.originalDomain}`,
		body,
		recipientLabel: providerLabel,
	};
}

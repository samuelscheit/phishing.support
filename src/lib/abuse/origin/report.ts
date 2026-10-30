import ipaddr from "ipaddr.js";

import { createWebsiteSubmission, type WebsiteSubmissionOptions } from "../../submissions/website";
import { normalizeDomain } from "../security";
import { AbuseRepository } from "../repository";
import { parseJobBigInt, throwIfAborted } from "../worker/shared";
import { parseCloudflareOriginDisclosure } from "./disclosure";
import { resolveOriginHostNetworks, type OriginNetworkResolution } from "./network";
import { discoverSiblingDomains, type SiblingDiscoveryResult } from "./siblings";
import { readOriginHostSnapshot, type OriginHostSnapshot } from "./snapshot";
import { findOriginServers, planOriginSweep, type OriginServer, type OriginSweepPlan } from "./sweep";

const ORIGIN_ROUTE_PROVIDER_KEY = "origin-host-email";
const ORIGIN_EVIDENCE_KIND = "origin_host_evidence";
const ORIGIN_EVIDENCE_NAME = "origin-host-evidence.txt";

export type OriginHostReportDependencies = {
	resolveNetworks?: typeof resolveOriginHostNetworks;
	findServers?: typeof findOriginServers;
	discoverSiblings?: typeof discoverSiblingDomains;
	createSiblingSubmission?: (options: WebsiteSubmissionOptions) => Promise<bigint>;
};

function errorDetail(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
}

function containingPrefix(ip: string, prefixes: OriginSweepPlan["selectedPrefixes"]) {
	try {
		const address = ipaddr.parse(ip);
		return prefixes.find(({ prefix }) => {
			try {
				const cidr = ipaddr.parseCIDR(prefix);
				return address.kind() === cidr[0].kind() && address.match(cidr);
			} catch {
				return false;
			}
		});
	} catch {
		return undefined;
	}
}

function providerLabel(disclosed: string | undefined, resolution: OriginNetworkResolution): string {
	if (disclosed?.trim()) return disclosed.replace(/\s+/g, " ").trim().slice(0, 200);
	const holders = [...new Set(resolution.networks.map(({ holder }) => holder))];
	return holders.join(" / ").slice(0, 200) || resolution.mailboxDomain;
}

function cloudflareReportId(subject: string | null): string | undefined {
	return subject?.match(/\b([a-f0-9]{16})\b/i)?.[1]?.toLowerCase();
}

export function originHostEvidence(snapshot: OriginHostSnapshot): Buffer {
	const lines = [
		`Cloudflare origin-host evidence for ${snapshot.originalDomain}`,
		`Source provider message: ${snapshot.sourceMessageId}`,
		`Observed: ${snapshot.observedAt}`,
		`Hosting abuse contact: ${snapshot.recipient}`,
		...(snapshot.cloudflareReportId ? [`Cloudflare report: ${snapshot.cloudflareReportId}`] : []),
		"",
		"Validated networks:",
		...(snapshot.networks.length
			? snapshot.networks.map((network) => `AS${network.asn} ${network.holder} (${network.prefixes.length} announced IPv4/IPv6 prefixes; matched through ${network.discoverySources.join(", ")})`)
			: ["No ASN was validated against the disclosed abuse mailbox."]),
		"",
		`TLS sweep: ${snapshot.scan.addressesScanned} of ${snapshot.scan.totalAddresses} public IPv4 addresses${snapshot.scan.truncated ? " (capped)" : ""}`,
		...snapshot.scan.selectedPrefixes.map(({ asn, prefix }) => `- AS${asn} ${prefix}`),
		"",
		"Servers presenting a certificate for the reported domain:",
		...(snapshot.servers.length ? snapshot.servers.flatMap((server) => [
			`- ${server.ip}${server.asn ? ` AS${server.asn}` : ""}${server.prefix ? ` ${server.prefix}` : ""}`,
			`  names: ${server.certificate.names.join(", ")}`,
			`  issuer: ${server.certificate.issuer}`,
			`  validity: ${server.certificate.notBefore} to ${server.certificate.notAfter}`,
			`  SHA-256: ${server.certificate.fingerprint256}`,
		]) : ["- none found within the bounded scan"]),
		"",
		"Captured kit fingerprints searched on urlscan.io:",
		...(snapshot.fingerprints.length
			? snapshot.fingerprints.map((fingerprint) => `- ${fingerprint.sha256} ${fingerprint.mimeType} ${fingerprint.size} bytes ${fingerprint.url}`)
			: ["- none"]),
		"",
		"Sibling domains confirmed by both a matching kit hash and the origin certificate:",
		...(snapshot.siblings.length
			? snapshot.siblings.map((sibling) => `- ${sibling.domain} at ${sibling.originIp}; hashes ${sibling.matchingHashes.join(", ")}; submission ${sibling.submissionId}`)
			: ["- none"]),
		...(snapshot.errors.length ? ["", "Non-fatal discovery errors:", ...snapshot.errors.map((error) => `- ${error}`)] : []),
	];
	return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

async function ensureDelivery(reportId: bigint, routeId: bigint, snapshot: OriginHostSnapshot): Promise<void> {
	const existingEvidence = await AbuseRepository.listRouteArtifacts(routeId, [ORIGIN_EVIDENCE_KIND]);
	if (existingEvidence.length === 0) {
		await AbuseRepository.saveRouteArtifactOnce({
			reportId,
			routeId,
			name: ORIGIN_EVIDENCE_NAME,
			kind: ORIGIN_EVIDENCE_KIND,
			mimeType: "text/plain",
			buffer: originHostEvidence(snapshot),
			metadata: { source: "cloudflare_origin_disclosure", sourceMessageId: snapshot.sourceMessageId },
		});
	}
	const route = await AbuseRepository.getRoute(routeId);
	if (route?.status === "verified") {
		await AbuseRepository.enqueueJob({
			jobType: "send_email",
			reportId,
			routeId,
			payload: {},
			dedupeKey: `email:${routeId.toString()}`,
		});
	}
}

/** Execute one immutable Cloudflare host disclosure from evidence to a normal email route. */
export async function reportOriginHost(params: {
	reportId: bigint;
	messageId: bigint;
	signal?: AbortSignal;
}, dependencies: OriginHostReportDependencies = {}): Promise<void> {
	const message = await AbuseRepository.getMailMessage(params.messageId);
	if (!message || message.reportId !== params.reportId || message.direction !== "inbound" || message.kind !== "provider_api") return;
	const sourceRoute = await AbuseRepository.getRoute(message.routeId);
	if (!sourceRoute || sourceRoute.providerRegistryKey !== "cloudflare") return;
	const disclosure = parseCloudflareOriginDisclosure(message.textBody);
	if (!disclosure) return;
	const sourceTarget = await AbuseRepository.getTarget(sourceRoute.targetId);
	const report = await AbuseRepository.getReport(params.reportId);
	if (!sourceTarget || !report) return;
	const originalDomain = sourceTarget.targetType === "domain" ? normalizeDomain(sourceTarget.normalizedTarget) : undefined;
	if (!originalDomain) throw new Error("Cloudflare origin disclosure is not attached to a valid domain target.");
	const routeKey = `origin-host:${disclosure.recipient}`;

	// A retry after route creation reuses the immutable snapshot and only repairs
	// a missing artifact/job. Never run a second network scan or alter sent prose.
	const reportRoutes = await AbuseRepository.listRoutes(params.reportId);
	const existing = reportRoutes.find((route) => route.routeKey === routeKey);
	if (existing) {
		const snapshot = readOriginHostSnapshot(existing.resolutionSnapshot);
		if (!snapshot) throw new Error("Existing origin-host route has an invalid immutable snapshot.");
		await ensureDelivery(params.reportId, existing.id, snapshot);
		return;
	}
	// A staff-created or resolver-created route may already have reported this
	// exact disclosed mailbox. Continue discovery so sibling cases are created,
	// but never send a second complaint to the same recipient for one report.
	const recipientAlreadyReported = reportRoutes.some((route) => route.routeType === "email" && route.verifiedEmail === disclosure.recipient);

	throwIfAborted(params.signal);
	const errors: string[] = [];
	let networkResolution: OriginNetworkResolution;
	try {
		networkResolution = await (dependencies.resolveNetworks ?? resolveOriginHostNetworks)(disclosure.recipient, params.signal);
		errors.push(...networkResolution.errors);
	} catch (error) {
		const recipientDomain = disclosure.recipient.split("@")[1]!;
		networkResolution = { recipient: disclosure.recipient, mailboxDomain: recipientDomain, networks: [], errors: [] };
		errors.push(`network attribution: ${errorDetail(error)}`);
	}
	const sweepPlan = planOriginSweep(networkResolution.networks.flatMap((network) =>
		network.prefixes.map((prefix) => ({ asn: network.asn, prefix }))
	));
	let servers: OriginServer[] = [];
	try {
		servers = sweepPlan.addresses.length
			? await (dependencies.findServers ?? findOriginServers)({ domain: originalDomain, addresses: sweepPlan.addresses, signal: params.signal })
			: [];
	} catch (error) {
		errors.push(`TLS sweep: ${errorDetail(error)}`);
	}

	let siblingDiscovery: SiblingDiscoveryResult = { fingerprints: [], candidateCount: 0, confirmed: [], errors: [] };
	if (report.submissionId) {
		try {
			siblingDiscovery = await (dependencies.discoverSiblings ?? discoverSiblingDomains)({
				submissionId: report.submissionId,
				originalDomain,
				originServers: servers,
				signal: params.signal,
			});
			errors.push(...siblingDiscovery.errors);
		} catch (error) {
			errors.push(`sibling discovery: ${errorDetail(error)}`);
		}
	}

	const siblingSubmissions: OriginHostSnapshot["siblings"] = [];
	const createSibling = dependencies.createSiblingSubmission ?? createWebsiteSubmission;
	for (const sibling of siblingDiscovery.confirmed) {
		try {
			throwIfAborted(params.signal);
			const submissionId = await createSibling({
				url: sibling.url,
				source: `origin-sibling:${report.submissionId?.toString() ?? "standalone"}:${params.messageId.toString()}`,
				reporterIp: report.requesterIp ?? undefined,
				reporterCountry: report.requesterCountry ?? undefined,
				reporterHeaders: report.requesterHeaders ?? undefined,
			});
			siblingSubmissions.push({ ...sibling, submissionId: submissionId.toString() });
		} catch (error) {
			errors.push(`sibling ${sibling.domain}: ${errorDetail(error)}`);
		}
	}

	const reportConfirmationId = cloudflareReportId(message.subject);
	const snapshot: OriginHostSnapshot = {
		kind: "cloudflare_origin_host",
		version: 1,
		recipient: networkResolution.recipient,
		providerLabel: providerLabel(disclosure.providerLabel, networkResolution),
		originalDomain,
		sourceMessageId: params.messageId.toString(),
		...(reportConfirmationId ? { cloudflareReportId: reportConfirmationId } : {}),
		observedAt: message.occurredAt.toISOString(),
		networks: networkResolution.networks,
		scan: {
			addressesScanned: sweepPlan.addresses.length,
			totalAddresses: sweepPlan.totalAddresses,
			truncated: sweepPlan.truncated,
			selectedPrefixes: sweepPlan.selectedPrefixes,
		},
		servers: servers.map((server) => {
			const network = containingPrefix(server.ip, sweepPlan.selectedPrefixes);
			return { ...server, ...(network ? { asn: network.asn, prefix: network.prefix } : {}) };
		}),
		fingerprints: siblingDiscovery.fingerprints,
		siblingCandidateCount: siblingDiscovery.candidateCount,
		siblings: siblingSubmissions,
		errors: errors.slice(0, 100),
	};
	const observedUrls = [...new Set([
		...sourceTarget.observedUrls,
		...(sourceTarget.observedUrls.length ? [] : [`https://${originalDomain}/`]),
		...siblingSubmissions.map(({ url }) => url),
	])];
	if (recipientAlreadyReported) return;
	const routeTarget = servers[0]
		? await AbuseRepository.upsertDerivedTarget({
			reportId: params.reportId,
			normalizedTarget: servers[0].ip,
			targetType: "ip",
			observedUrls,
			resolverSnapshot: snapshot,
			disposition: "cloudflare_origin_host",
		})
		: sourceTarget;
	const route = await AbuseRepository.upsertResolvedRoute(routeTarget.id, {
		routeKey,
		providerRegistryKey: ORIGIN_ROUTE_PROVIDER_KEY,
		providerDisplayName: snapshot.providerLabel,
		routeType: "email",
		verifiedEmail: snapshot.recipient,
		resolverProvenance: {
			source: "cloudflare_origin_disclosure",
			sourceMessageId: snapshot.sourceMessageId,
			networkValidation: "ripestat_abuse_contact_exact_match",
		},
		resolutionSnapshot: snapshot,
		status: "verified",
	});
	await ensureDelivery(params.reportId, route.id, snapshot);
	await AbuseRepository.recomputeReportStatus(params.reportId);
}

export async function reportOriginHostJob(payload: Record<string, unknown> | null | undefined, reportId: bigint, signal?: AbortSignal): Promise<void> {
	await reportOriginHost({ reportId, messageId: parseJobBigInt(payload?.messageId, "payload.messageId"), signal });
}

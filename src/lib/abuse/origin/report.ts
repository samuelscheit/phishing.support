import ipaddr from "ipaddr.js";
import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";

import { ArtifactsEntity, SubmissionsEntity } from "../../db/entities";
import { queryRDAPDomain } from "../../website_info";
import { createWebsiteSubmission, type WebsiteSubmissionOptions } from "../../submissions/website";
import { normalizeDomain, registrableDomain } from "../security";
import { AbuseRepository } from "../repository";
import type { AbuseJob } from "../schema";
import { parseJobBigInt, throwIfAborted } from "../worker/shared";
import { parseCloudflareOriginDisclosure } from "./disclosure";
import { capturedKitFacts } from "./kit_facts";
import { isKitSiblingSeed } from "./kit_job";
import { resolveOriginHostNetworks } from "./network";
import { discoverSiblingDomains, kitFingerprints, type SiblingDiscoveryResult } from "./siblings";
import { originSweepProgressSchema, readOriginHostSnapshot, type OriginHostSnapshot, type OriginSweepProgress } from "./snapshot";
import { findOriginServers, MAX_ORIGIN_RESULTS, originSweepAddresses, planOriginSweep, SWEEP_SLICE_ADDRESSES, type OriginSweepPlan, type OriginVerificationTarget } from "./sweep";
import { errorSummary } from "../../error_text";

const ORIGIN_ROUTE_PROVIDER_KEY = "origin-host-email";
const ORIGIN_EVIDENCE_KIND = "origin_host_evidence";
const ORIGIN_EVIDENCE_NAME = "origin-host-evidence.txt";
const MAX_ERRORS = 100;

export type OriginHostReportDependencies = {
	resolveNetworks?: typeof resolveOriginHostNetworks;
	findServers?: typeof findOriginServers;
	discoverSiblings?: typeof discoverSiblingDomains;
	createSiblingSubmission?: (options: WebsiteSubmissionOptions) => Promise<bigint>;
	kitFacts?: typeof capturedKitFacts;
	registeredAt?: (domain: string) => Promise<string | undefined>;
	/** Addresses one invocation sweeps before queueing its successor. */
	sliceAddresses?: number;
};

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

/** RIPEstat holders read "AS-NAME - Organization, CC"; the AS name is what a host calls itself. */
function holderName(holder: string): string {
	return holder.match(/^(\S+) - .+, [A-Z]{2}$/)?.[1] ?? holder;
}

function providerLabel(disclosed: string | undefined, networks: OriginSweepProgress["networks"], recipient: string): string {
	if (disclosed?.trim()) return disclosed.replace(/\s+/g, " ").trim().slice(0, 200);
	const holders = [...new Set(networks.map(({ holder }) => holderName(holder)))];
	return holders.join(" / ").slice(0, 200) || recipient.split("@")[1]!;
}

function cloudflareReportId(subject: string | null): string | undefined {
	return subject?.match(/\b([a-f0-9]{16})\b/i)?.[1]?.toLowerCase();
}

/** Registration time of a domain's registrable parent, from the case capture or a fresh RDAP query. */
async function domainRegisteredAt(domain: string): Promise<string | undefined> {
	const registrable = registrableDomain(domain) ?? domain;
	const registration = (await queryRDAPDomain(registrable))?.events.registration;
	const parsed = registration ? new Date(registration) : undefined;
	return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
}

async function submissionRegisteredAt(submissionId: bigint): Promise<string | undefined> {
	const submission = await SubmissionsEntity.get(submissionId);
	const registration = submission?.data.kind === "website" ? submission.data.website.whois?.rdap?.events.registration : undefined;
	const parsed = registration ? new Date(registration) : undefined;
	return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
}

async function originVerificationTargets(submissionId: bigint | null, domain: string): Promise<OriginVerificationTarget[]> {
	if (!submissionId) return [];
	const submission = await SubmissionsEntity.get(submissionId);
	const resources = submission?.data.kind === "website" ? submission.data.website.kitResources : undefined;
	const liveTargets = kitFingerprints(resources ?? [], domain).map(({ url, sha256 }) => {
		const parsed = new URL(url);
		return { path: `${parsed.pathname}${parsed.search}`, sha256 };
	});
	if (liveTargets.length) return liveTargets;

	// Uploaded and inherited captures have no live response recorder. Chromium's
	// MHTML still retains same-host stylesheets as decoded MIME parts, which are
	// safe exact-byte verification targets (scripts are deliberately not guessed).
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const mhtmlReference = artifacts.find(({ kind, mimeType, name }) =>
		kind === "website_mhtml" || mimeType?.toLowerCase() === "text/mhtml" || name?.toLowerCase() === "website.mhtml");
	if (!mhtmlReference) return [];
	const mhtml = await ArtifactsEntity.get(mhtmlReference.id);
	if (!mhtml?.blob) return [];
	const parsed = await simpleParser(mhtml.blob);
	const targets = new Map<string, OriginVerificationTarget>();
	for (const attachment of parsed.attachments) {
		if (attachment.contentType !== "text/css" || attachment.content.byteLength < 1_024) continue;
		const location = attachment.headers.get("content-location");
		if (typeof location !== "string") continue;
		let url: URL;
		try {
			url = new URL(location);
		} catch {
			continue;
		}
		if (url.hostname !== domain) continue;
		const path = `${url.pathname}${url.search}`;
		targets.set(path, { path, sha256: createHash("sha256").update(attachment.content).digest("hex") });
		if (targets.size >= 5) break;
	}
	return [...targets.values()];
}

export function originHostEvidence(snapshot: OriginHostSnapshot): Buffer {
	const certificateLines = (certificate: OriginHostSnapshot["servers"][number]["certificate"]) => [
		`  names: ${certificate.names.join(", ")}`,
		`  issuer: ${certificate.issuer}`,
		`  validity: ${certificate.notBefore} to ${certificate.notAfter}`,
		`  SHA-256: ${certificate.fingerprint256}`,
	];
	const lines = [
		`Cloudflare origin-host evidence for ${snapshot.originalDomain}`,
		`Source provider message: ${snapshot.sourceMessageId}`,
		`Observed: ${snapshot.observedAt}`,
		`Hosting abuse contact: ${snapshot.recipient}`,
		...(snapshot.cloudflareReportId ? [`Cloudflare report: ${snapshot.cloudflareReportId}`] : []),
		...(snapshot.originalDomainRegisteredAt ? [`${snapshot.originalDomain} registered: ${snapshot.originalDomainRegisteredAt}`] : []),
		"",
		"Validated networks:",
		...(snapshot.networks.length
			? snapshot.networks.map((network) => `AS${network.asn} ${network.holder} (${network.prefixes.length} announced IPv4/IPv6 prefixes; matched through ${network.discoverySources.join(", ")})`)
			: ["No ASN was validated against the disclosed abuse mailbox."]),
		"",
		`TLS sweep (completed ${snapshot.scan.completedAt}): ${snapshot.scan.addressesScanned} of ${snapshot.scan.totalAddresses} public IPv4 addresses${snapshot.scan.truncated ? " (capped)" : ""}`,
		...snapshot.scan.selectedPrefixes.map(({ asn, prefix }) => `- AS${asn} ${prefix}`),
		"",
		"Servers returning exact captured kit bytes (and presenting the reported domain's certificate):",
		...(snapshot.servers.length ? snapshot.servers.flatMap((server) => [
			`- ${server.ip}${server.asn ? ` AS${server.asn}` : ""}${server.prefix ? ` ${server.prefix}` : ""}`,
			...certificateLines(server.certificate),
			`  check: openssl s_client -connect ${server.ip}:443 -servername ${snapshot.originalDomain}`,
		]) : ["- none found within the scan"]),
		"",
		"Captured kit:",
		`- basis: ${snapshot.kit.phishingBasis ?? "unspecified"}`,
		...(snapshot.kit.evidenceQuote ? [`- page text: "${snapshot.kit.evidenceQuote}"`] : []),
		`- collects: ${snapshot.kit.collects.join(", ") || "not determined from the first page"}`,
		...(snapshot.kit.exfiltrationTargets.length ? [`- exfiltration backends: ${snapshot.kit.exfiltrationTargets.join(", ")}`] : []),
		"",
		"Captured kit fingerprints searched on urlscan.io:",
		...(snapshot.fingerprints.length
			? snapshot.fingerprints.map((fingerprint) => `- ${fingerprint.sha256} ${fingerprint.mimeType} ${fingerprint.size} bytes ${fingerprint.url}`)
			: ["- none"]),
		"",
		"Sibling domains confirmed by both a matching kit hash and the origin certificate:",
		...(snapshot.siblings.length
			? snapshot.siblings.flatMap((sibling) => [
				`- ${sibling.domain} at ${sibling.originIp}; submission ${sibling.submissionId}${sibling.registeredAt ? `; registered ${sibling.registeredAt}` : ""}`,
				`  hashes: ${sibling.matchingHashes.join(", ")}`,
				...certificateLines(sibling.certificate),
			])
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

/**
 * Execute one immutable Cloudflare host disclosure from evidence to a normal
 * email route. The TLS sweep can cover millions of addresses, so each
 * invocation sweeps one slice and hands its progress to a successor job;
 * discovery and the route are built only after the last slice.
 */
export async function reportOriginHost(params: {
	reportId: bigint;
	messageId: bigint;
	progress?: OriginSweepProgress;
	/** The running job, so its successor is not treated as its duplicate. */
	jobId?: bigint;
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

	throwIfAborted(params.signal);
	let progress = params.progress;
	if (!progress) {
		try {
			const resolution = await (dependencies.resolveNetworks ?? resolveOriginHostNetworks)(disclosure.recipient, params.signal);
			progress = { networks: resolution.networks, offset: 0, servers: [], errors: resolution.errors.slice(0, MAX_ERRORS) };
		} catch (error) {
			progress = { networks: [], offset: 0, servers: [], errors: [`network attribution: ${errorSummary(error)}`] };
		}
	}
	const sweepPlan = planOriginSweep(progress.networks.flatMap((network) =>
		network.prefixes.map((prefix) => ({ asn: network.asn, prefix }))
	));
	const verificationTargets = await originVerificationTargets(report.submissionId, originalDomain);
	if (progress.offset < sweepPlan.addressCount) {
		const slice = originSweepAddresses(sweepPlan, progress.offset, dependencies.sliceAddresses ?? SWEEP_SLICE_ADDRESSES);
		const servers = [...progress.servers];
		const errors = [...progress.errors];
		try {
			servers.push(...await (dependencies.findServers ?? findOriginServers)({
				domain: originalDomain,
				addresses: slice,
				verificationTargets,
				maxResults: MAX_ORIGIN_RESULTS - servers.length,
				signal: params.signal,
			}));
		} catch (error) {
			throwIfAborted(params.signal);
			errors.push(`TLS sweep at offset ${progress.offset}: ${errorSummary(error)}`);
		}
		const next: OriginSweepProgress = {
			networks: progress.networks,
			offset: progress.offset + slice.length,
			servers: servers.slice(0, MAX_ORIGIN_RESULTS),
			errors: errors.slice(0, MAX_ERRORS),
		};
		if (next.offset < sweepPlan.addressCount) {
			await AbuseRepository.enqueueJob({
				jobType: "report_origin_host",
				reportId: params.reportId,
				payload: { messageId: params.messageId.toString(), progress: next },
				dedupeKey: `origin-host-sweep:${params.messageId.toString()}`,
				...(params.jobId === undefined ? {} : { successorOf: params.jobId }),
			});
			return;
		}
		progress = next;
	}
	await completeOriginHostReport({ report, message, disclosure, sourceTarget, originalDomain, routeKey, reportRoutes, progress, sweepPlan, signal: params.signal }, dependencies);
}

async function completeOriginHostReport(params: {
	report: NonNullable<Awaited<ReturnType<typeof AbuseRepository.getReport>>>;
	message: NonNullable<Awaited<ReturnType<typeof AbuseRepository.getMailMessage>>>;
	disclosure: NonNullable<ReturnType<typeof parseCloudflareOriginDisclosure>>;
	sourceTarget: NonNullable<Awaited<ReturnType<typeof AbuseRepository.getTarget>>>;
	originalDomain: string;
	routeKey: string;
	reportRoutes: Awaited<ReturnType<typeof AbuseRepository.listRoutes>>;
	progress: OriginSweepProgress;
	sweepPlan: OriginSweepPlan;
	signal?: AbortSignal;
}, dependencies: OriginHostReportDependencies): Promise<void> {
	const { report, message, disclosure, sourceTarget, originalDomain, progress, sweepPlan } = params;
	const errors = [...progress.errors];
	const servers = progress.servers;
	// A staff-created or resolver-created route may already have reported this
	// exact disclosed mailbox. Continue discovery so sibling cases are created,
	// but never send a second complaint to the same recipient for one report.
	const recipientAlreadyReported = params.reportRoutes.some((route) => route.routeType === "email" && route.verifiedEmail === disclosure.recipient);

	let siblingDiscovery: SiblingDiscoveryResult = { fingerprints: [], candidateCount: 0, confirmed: [], errors: [] };
	if (report.submissionId && await isKitSiblingSeed(report.submissionId)) {
		try {
			siblingDiscovery = await (dependencies.discoverSiblings ?? discoverSiblingDomains)({
				submissionId: report.submissionId,
				originalDomain,
				originServers: servers,
				signal: params.signal,
			});
			errors.push(...siblingDiscovery.errors);
		} catch (error) {
			errors.push(`sibling discovery: ${errorSummary(error)}`);
		}
	}

	const registeredAt = dependencies.registeredAt ?? domainRegisteredAt;
	const siblingSubmissions: OriginHostSnapshot["siblings"] = [];
	const createSibling = dependencies.createSiblingSubmission ?? createWebsiteSubmission;
	for (const sibling of siblingDiscovery.confirmed) {
		try {
			throwIfAborted(params.signal);
			const submissionId = await createSibling({
				url: sibling.url,
				source: `origin-sibling:${report.submissionId?.toString() ?? "standalone"}:${message.id.toString()}`,
				reporterIp: report.requesterIp ?? undefined,
				reporterCountry: report.requesterCountry ?? undefined,
				reporterHeaders: report.requesterHeaders ?? undefined,
			});
			const siblingRegisteredAt = await registeredAt(sibling.domain).catch(() => undefined);
			siblingSubmissions.push({ ...sibling, ...(siblingRegisteredAt ? { registeredAt: siblingRegisteredAt } : {}), submissionId: submissionId.toString() });
		} catch (error) {
			errors.push(`sibling ${sibling.domain}: ${errorSummary(error)}`);
		}
	}

	let kit: OriginHostSnapshot["kit"] = { collects: [], exfiltrationProbed: false, exfiltrationTargets: [] };
	let originalDomainRegisteredAt: string | undefined;
	if (report.submissionId) {
		try {
			kit = await (dependencies.kitFacts ?? capturedKitFacts)(report.submissionId);
		} catch (error) {
			errors.push(`kit facts: ${errorSummary(error)}`);
		}
		originalDomainRegisteredAt = await submissionRegisteredAt(report.submissionId).catch(() => undefined);
	}
	originalDomainRegisteredAt ??= await registeredAt(originalDomain).catch(() => undefined);

	const reportConfirmationId = cloudflareReportId(message.subject);
	const snapshot: OriginHostSnapshot = {
		kind: "cloudflare_origin_host",
		version: 2,
		recipient: disclosure.recipient,
		providerLabel: providerLabel(disclosure.providerLabel, progress.networks, disclosure.recipient),
		originalDomain,
		...(originalDomainRegisteredAt ? { originalDomainRegisteredAt } : {}),
		sourceMessageId: message.id.toString(),
		...(reportConfirmationId ? { cloudflareReportId: reportConfirmationId } : {}),
		observedAt: message.occurredAt.toISOString(),
		networks: progress.networks,
		scan: {
			addressesScanned: Math.min(progress.offset, sweepPlan.addressCount),
			totalAddresses: sweepPlan.totalAddresses,
			truncated: sweepPlan.truncated,
			selectedPrefixes: sweepPlan.selectedPrefixes,
			completedAt: new Date().toISOString(),
		},
		servers: servers.map((server) => {
			const network = containingPrefix(server.ip, sweepPlan.selectedPrefixes);
			return { ...server, ...(network ? { asn: network.asn, prefix: network.prefix } : {}) };
		}).sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })),
		kit,
		fingerprints: siblingDiscovery.fingerprints,
		siblingCandidateCount: siblingDiscovery.candidateCount,
		siblings: siblingSubmissions,
		errors: errors.slice(0, MAX_ERRORS),
	};
	const observedUrls = [...new Set([
		...sourceTarget.observedUrls,
		...(sourceTarget.observedUrls.length ? [] : [`https://${originalDomain}/`]),
		...siblingSubmissions.map(({ url }) => url),
	])];
	if (recipientAlreadyReported) return;
	const routeTarget = servers[0]
		? await AbuseRepository.upsertDerivedTarget({
			reportId: report.id,
			normalizedTarget: snapshot.servers[0]!.ip,
			targetType: "ip",
			observedUrls,
			resolverSnapshot: snapshot,
			disposition: "cloudflare_origin_host",
		})
		: sourceTarget;
	const route = await AbuseRepository.upsertResolvedRoute(routeTarget.id, {
		routeKey: params.routeKey,
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
	await ensureDelivery(report.id, route.id, snapshot);
	await AbuseRepository.recomputeReportStatus(report.id);
}

export async function reportOriginHostJob(job: Pick<AbuseJob, "id" | "payload">, reportId: bigint, signal?: AbortSignal): Promise<void> {
	const progress = job.payload?.progress === undefined ? undefined : originSweepProgressSchema.parse(job.payload.progress);
	await reportOriginHost({
		reportId,
		messageId: parseJobBigInt(job.payload?.messageId, "payload.messageId"),
		progress,
		jobId: job.id,
		signal,
	});
}

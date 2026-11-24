import { getDomain } from "tldts";

import { AbuseRepository } from "../abuse/repository";
import { isPlatformHost, kitFingerprints } from "../abuse/origin/siblings";
import { DAY_MS } from "../util/date_time";
import { isPopularSite, loadPopularDomains, type PopularDomains } from "../abuse/origin/popular_domains";
import { SubmissionsEntity } from "../db/entities/submissions";
import { ArtifactsEntity } from "../db/entities/artifacts";
import type { Submission, WebsiteSubmissionData } from "../db/schema";
import { fetchJson } from "../network/bounded_fetch";
import { mhtmlVisitorText } from "../website/archive/text";
import { latestArtifactNamed, websiteCaptureFileNames } from "../website/visit/capture_files";
import { hasPathTenants } from "../website/info/site";
import type { ExfiltrationBackend } from "../exfiltration/types";
import { deliveryCommandsOf } from "./delivery";
import { headlineSite, judgedSitePage, sitePageSteps, siteOf, type CampaignMember, type CampaignSite, type SitePage } from "./members";
import { loadPageFingerprints, type PageFingerprints } from "./page_document";
import { paymentReceivers } from "./payment";
import type { CampaignIndicatorEvidence, CampaignIndicatorKind, OperatorServerRole } from "./schema";
import { type FetchLike } from "../http/fetch";

export type ExtractedIndicator = {
	kind: CampaignIndicatorKind;
	value: string;
	links: boolean;
	evidence: CampaignIndicatorEvidence;
};

/** The visitor-readable text of one captured page, named after its capture file (`websiteCaptureFileNames(step).mhtml`). */
export type PageText = { name: string; text: string };

export type IndicatorDependencies = {
	loadSubmission?: (submissionId: bigint) => Promise<Submission | undefined>;
	/** Backends the investigation of the member's report found and reported. */
	loadBackends?: (member: CampaignMember) => Promise<Array<{ backend: ExfiltrationBackend; observedAt: string; reportId: string }>>;
	/** The visitor-readable text of every captured page of the case. */
	loadPageTexts?: (submissionId: bigint) => Promise<PageText[]>;
	/** The published library a kit file's bytes are, or undefined when none is. */
	libraryFor?: (sha256: string) => Promise<string | undefined>;
	/** Whether a host other than the site's that serves it kit files is a platform's asset host. */
	isPlatformHost?: (host: string) => Promise<boolean>;
	loadPopularDomains?: () => Promise<PopularDomains>;
	/** The judged page's body and structure (page_document.ts). */
	loadPageFingerprints?: (submissionId: bigint, page: SitePage) => Promise<PageFingerprints>;
};

/** The identity two sites share when they use the same server of their operator: a Telegram bot, a Discord webhook, or a host. */
export function backendIndicatorValue(backend: ExfiltrationBackend): string | undefined {
	if (backend.kind === "telegram_bot") {
		const botId = backend.telegram?.botId ?? backend.telegram?.token.split(":", 1)[0];
		return botId && /^\d{1,20}$/.test(botId) ? `telegram-bot:${botId}` : undefined;
	}
	if (backend.kind === "discord_webhook") return backend.discord?.webhookId ? `discord-webhook:${backend.discord.webhookId}` : undefined;
	return backend.hostname ? `host:${backend.hostname.toLowerCase()}` : undefined;
}

/**
 * The data drops the case reported from the investigation of the member's
 * report (`sourceReportId`). The visit's drops go with the first report the
 * case filed itself, so a site whose report another case owns has none.
 */
async function loadReportedBackends(member: CampaignMember) {
	const backends: Array<{ backend: ExfiltrationBackend; observedAt: string; reportId: string }> = [];
	for (const report of await AbuseRepository.listReportsForSubmission(member.submissionId)) {
		if (!report.idempotencyKey?.startsWith("exfil:")) continue;
		const [request] = await AbuseRepository.listArtifacts(report.id, ["original_request"]);
		if (!request) continue;
		const original = JSON.parse(Buffer.from(request.blob).toString("utf8")) as { kind?: string; sourceReportId?: string; backend?: ExfiltrationBackend; observedAt?: string };
		if (original.kind === "exfiltration_backend" && original.backend && original.sourceReportId === member.reportId.toString()) {
			backends.push({ backend: original.backend, observedAt: original.observedAt ?? report.createdAt.toISOString(), reportId: report.id.toString() });
		}
	}
	return backends;
}

/** Each captured page of the case as a visitor reads it; a capture that cannot be read is skipped. */
export async function loadCapturedPageTexts(submissionId: bigint) {
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const texts: PageText[] = [];
	for (let step = 0; step < 20; step += 1) {
		const meta = latestArtifactNamed(artifacts, websiteCaptureFileNames(step).mhtml);
		if (!meta) break;
		const artifact = await ArtifactsEntity.get(BigInt(meta.id));
		if (!artifact) continue;
		try {
			texts.push({ name: meta.name ?? `step ${step}`, text: await mhtmlVisitorText(Buffer.from(artifact.blob)) });
		} catch {
			// A damaged archive has no readable text; the other pages still count.
		}
	}
	return texts;
}

/** The pages of the case's capture that show the member's site: what the site itself told its visitors. */
export async function sitePageTexts(member: CampaignSite, website: WebsiteSubmissionData, dependencies: Pick<IndicatorDependencies, "loadPageTexts"> = {}): Promise<PageText[]> {
	const texts = await (dependencies.loadPageTexts ?? loadCapturedPageTexts)(member.submissionId);
	const steps = sitePageSteps(website, member.site);
	if (!steps) return texts;
	const names = new Set(steps.map((step) => websiteCaptureFileNames(step).mhtml));
	return texts.filter((page) => names.has(page.name));
}

const JSDELIVR_HASH_LOOKUP = "https://data.jsdelivr.com/v1/lookup/hash/";

/**
 * Ask jsDelivr whether these bytes are a file of a published npm or GitHub
 * package. A kit that self-hosts jQuery shares that file with thousands of
 * unrelated sites, so such a file never links two sites.
 */
export async function lookupPublishedLibrary(sha256: string, fetchImplementation?: FetchLike): Promise<string | undefined> {
	const found = await fetchJson<{ type?: string; name?: string; version?: string; file?: string }>(`${JSDELIVR_HASH_LOOKUP}${sha256}`, {
		method: "GET",
		headers: { Accept: "application/json" },
	}, { fetch: fetchImplementation, timeoutMs: 10_000, attempts: 2, retryDelayMs: 1_000, maxResponseBytes: 64 * 1024 });
	// 404: no published package has these bytes.
	if (found === undefined) return undefined;
	if (!found.name) throw new Error("jsDelivr answered without a package name.");
	return `${found.type ?? "package"}:${found.name}@${found.version ?? "?"}${found.file ?? ""}`;
}

/** The library check, remembered per hash: a published file never stops being one. */
async function cachedLibraryFor(sha256: string): Promise<string | undefined> {
	const { CampaignRepository } = await import("./repository");
	const cached = await CampaignRepository.getKitHashCheck(sha256);
	if (cached) return cached.library ?? undefined;
	const library = await lookupPublishedLibrary(sha256);
	await CampaignRepository.saveKitHashCheck(sha256, library);
	return library;
}

/** A platform stays one, an operator's host rarely becomes one: the answer is reused for a month. */
const PLATFORM_RECHECK_MS = 30 * DAY_MS;

async function cachedPlatformHost(host: string): Promise<boolean> {
	const { CampaignRepository } = await import("./repository");
	const cached = await CampaignRepository.getKitHostCheck(host);
	if (cached && Date.now() - cached.checkedAt.getTime() < PLATFORM_RECHECK_MS) return cached.platform;
	const platform = await isPlatformHost(host);
	await CampaignRepository.saveKitHostCheck(host, platform);
	return platform;
}

/**
 * Everything one confirmed site shows about its operator, as one case saw
 * it. A server only the
 * operator controls links sites, whatever it did for them (received the
 * entered data, delivered the malware): a Telegram bot, a Discord webhook,
 * or a host that is not a public platform anyone can put files or forms on.
 * Payment receivers always link sites. A kit file links them
 * only when it is the kit's own code: a script or hidden frame of at least
 * 1 KiB, not served from a top-ranked site (a CDN, the copied brand), not a
 * published library file, and not served by a platform the site was built
 * on (a site builder's scripts are on every site built with it). A platform
 * file names the site's registrable domain as the scope its kit search keeps
 * to. The server address is recorded for the dossier but never links.
 *
 * A case's chain can confirm several sites, and each is linked by what it
 * showed itself, so two sites of one chain are one operator's only when
 * their evidence says so: the data drops its report's investigation found,
 * the text of its own pages, its judged page's body, the file its page
 * offered, and the server of the submitted address when that is the site.
 * What the case recorded once for its headline page (kit files, hidden
 * frames, fetched payloads) is the headline site's.
 */
export async function extractIndicators(member: CampaignSite, dependencies: IndicatorDependencies = {}): Promise<ExtractedIndicator[]> {
	const submission = await (dependencies.loadSubmission ?? SubmissionsEntity.get)(member.submissionId);
	if (submission?.data.kind !== "website") return [];
	const website = submission.data.website;
	const headline = headlineSite(website) === member.site;
	const indicators = new Map<string, ExtractedIndicator>();
	const add = (indicator: ExtractedIndicator) => {
		const key = `${indicator.kind}:${indicator.value}`;
		if (!indicators.has(key)) indicators.set(key, indicator);
	};

	let popularDomains: PopularDomains | undefined;
	const popularSites = async () => (popularDomains ??= await (dependencies.loadPopularDomains ?? loadPopularDomains)());

	// One host may play both roles for a site; its evidence then names both.
	const operatorServer = async (value: string, role: OperatorServerRole, evidence: CampaignIndicatorEvidence) => {
		const existing = indicators.get(`operator_server:${value}`);
		if (existing) {
			const roles = existing.evidence.roles as OperatorServerRole[];
			if (!roles.includes(role)) roles.push(role);
			for (const [key, entry] of Object.entries(evidence)) existing.evidence[key] ??= entry;
			return;
		}
		const host = value.startsWith("host:") ? value.slice("host:".length) : undefined;
		const shared = host !== undefined && (hasPathTenants(host) || isPopularSite(host, await popularSites()));
		add({ kind: "operator_server", value, links: !shared, evidence: { roles: [role], ...evidence } });
	};

	for (const { backend, observedAt, reportId } of await (dependencies.loadBackends ?? loadReportedBackends)(member)) {
		const value = backendIndicatorValue(backend);
		if (!value) continue;
		await operatorServer(value, "receives_data", {
			backendKind: backend.kind,
			endpointUrl: backend.endpointUrl,
			method: backend.method,
			observedAt,
			matchedFields: backend.matchedCanaries,
			reportId,
			...(backend.telegram ? { telegram: backend.telegram } : {}),
			...(backend.discord ? { discord: backend.discord } : {}),
		});
	}

	// What a pasted command fetches (only payloads the investigation actually
	// received) and the file a page offers.
	const offered = website.offeredDownload && siteOf(website.offeredDownload.pageUrl) === member.site ? website.offeredDownload : undefined;
	const deliveries = [
		...(headline ? website.investigation?.payloads ?? [] : []).filter((payload) => payload.sha256).map((payload) => ({ url: payload.url, sha256: payload.sha256, via: "pasted_command" })),
		...(offered ? [{ url: offered.url, sha256: offered.sha256, via: "offered_download" }] : []),
	];
	for (const delivery of deliveries) {
		let host: string;
		try {
			host = new URL(delivery.url).hostname.toLowerCase();
		} catch {
			continue;
		}
		await operatorServer(`host:${host}`, "delivers_malware", { delivered: delivery });
	}

	for (const page of await sitePageTexts(member, website, dependencies)) {
		for (const receiver of paymentReceivers(page.text)) {
			add({ kind: "payment_receiver", value: `${receiver.kind}:${receiver.value}`, links: true, evidence: { receiverKind: receiver.kind, receiver: receiver.value, page: page.name } });
		}
		for (const command of deliveryCommandsOf(page.text)) {
			add({ kind: "delivery_command", value: command.value, links: command.links, evidence: { template: command.template, shown: command.shown, interpreters: command.interpreters, page: page.name } });
		}
	}

	const fingerprints = headline ? kitFingerprints(website).filter((fingerprint) => fingerprint.kind !== "stylesheet") : [];
	if (fingerprints.length) {
		const popular = await popularSites();
		const siteHost = new URL(website.archiveUrl ?? website.url).hostname;
		for (const fingerprint of fingerprints) {
			const servedFrom = new URL(fingerprint.url).hostname;
			if (isPopularSite(servedFrom, popular)) continue;
			const library = await (dependencies.libraryFor ?? cachedLibraryFor)(fingerprint.sha256);
			const platform = library === undefined && servedFrom !== siteHost && await (dependencies.isPlatformHost ?? cachedPlatformHost)(servedFrom);
			add({
				kind: "kit_fingerprint",
				value: fingerprint.sha256,
				links: library === undefined && !platform,
				evidence: {
					fileKind: fingerprint.kind,
					url: fingerprint.url,
					size: fingerprint.size,
					...(library ? { library } : {}),
					...(platform ? { platform: servedFrom, scope: getDomain(siteHost) ?? siteHost } : {}),
				},
			});
		}
	}

	// The page itself: a kit deployed under many domains serves the same body, or one template's structure, on each.
	const judged = judgedSitePage(website, member.site);
	const page = judged ? await (dependencies.loadPageFingerprints ?? loadPageFingerprints)(member.submissionId, judged) : {};
	if (page.body) add({ kind: "kit_fingerprint", value: page.body.sha256, links: true, evidence: { fileKind: "page_document", url: judged!.url, size: page.body.size } });
	if (page.structure) add({ kind: "kit_fingerprint", value: page.structure.sha256, links: true, evidence: { fileKind: "page_structure", url: judged!.url, size: page.structure.size, tags: page.structure.tags } });

	// The case looked up the submitted address's server: it is this site's only when the chain started on it.
	for (const rdap of siteOf(website.url) === member.site ? website.whois?.ip_rdaps ?? [] : []) {
		if (!rdap.ip) continue;
		add({
			kind: "origin_ip",
			value: rdap.ip,
			links: false,
			evidence: {
				network: rdap.name ?? null,
				country: rdap.country ?? null,
				asns: rdap.origin_asns?.map((asn) => ({ asn: asn.asn, name: asn.rdap?.name ?? null })) ?? [],
				abuseEmail: rdap.abuse?.email ?? null,
			},
		});
	}
	return [...indicators.values()];
}

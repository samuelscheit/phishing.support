import { z } from "zod";

import { SubmissionsEntity } from "../../db/entities";
import { fetchJson, RequestStatusError, RequestTimeoutError, type FetchImplementation } from "../../network/bounded_fetch";
import type { WebsiteKitResource } from "../../website_types";
import { normalizeDomain, normalizePublicHttpUrl } from "../security";
import { throwIfAborted } from "../worker/shared";
import { mapConcurrent } from "./concurrency";
import { certificateCovers, presentedCertificate, type OriginServer, type PresentedCertificate, type TlsProbe } from "./sweep";
import { errorSummary } from "../../error_text";

const MAX_CANDIDATES = 100;
/** Below this, a file is too generic (a tracking snippet, a one-line loader) to identify a kit. */
const MIN_RESOURCE_BYTES = 1_024;
/**
 * A hash seen on more distinct domains than this is a shared library, theme
 * or framework file, not one operator's kit. This is also what excludes CDN
 * libraries a kit loads (jQuery, Bootstrap): they sit on thousands of domains.
 * A stylesheet is held to the tighter limit because templates and themes
 * reuse them across unrelated sites; that is what let discovery drift from a
 * phishing kit to 80+ gambling sites. One campaign's loader script reaches
 * dozens of front pages (39 for the Gmail `start.js` kit), so scripts get room.
 * urlscan returns at most 100 results per page; one past the limit must fit
 * in that page, or a hash on 10,000 domains reads as exactly 100.
 */
const MAX_SCRIPT_HASH_DOMAINS = 99;
const MAX_STYLESHEET_HASH_DOMAINS = 25;
const URLSCAN_SEARCH_URL = "https://urlscan.io/api/v1/search/";
const SCRIPT_MIME_TYPES = new Set(["text/javascript", "application/javascript", "application/x-javascript", "script"]);
const KIT_MIME_TYPES = new Set([...SCRIPT_MIME_TYPES, "text/css", "stylesheet"]);

const urlscanResponseSchema = z.object({
	has_more: z.boolean().optional(),
	results: z.array(z.object({
		page: z.object({ domain: z.string().optional(), url: z.string().optional() }).passthrough().optional(),
		task: z.object({ domain: z.string().optional(), url: z.string().optional() }).passthrough().optional(),
	}).passthrough()),
}).passthrough();

export type KitFingerprint = {
	sha256: string;
	mimeType: string;
	url: string;
	size: number;
};

export type ConfirmedSiblingDomain = {
	domain: string;
	url: string;
	matchingHashes: string[];
	originIp: string;
	certificate: PresentedCertificate;
};

export type KitSiblingCandidate = {
	domain: string;
	url: string;
	matchingHashes: string[];
};

export type KitSiblingSearchResult = {
	fingerprints: KitFingerprint[];
	candidates: KitSiblingCandidate[];
	errors: string[];
};

export type SiblingDiscoveryResult = {
	fingerprints: KitFingerprint[];
	candidateCount: number;
	confirmed: ConfirmedSiblingDomain[];
	errors: string[];
};

export type SiblingDiscoveryDependencies = {
	fetch?: FetchImplementation;
	apiKey?: string;
	loadKitResources?: (submissionId: bigint) => Promise<WebsiteKitResource[] | undefined>;
	probe?: TlsProbe;
};

const isScript = (mimeType: string) => SCRIPT_MIME_TYPES.has(mimeType);
const maxHashDomains = (mimeType: string) => isScript(mimeType) ? MAX_SCRIPT_HASH_DOMAINS : MAX_STYLESHEET_HASH_DOMAINS;

/**
 * Every script and stylesheet the captured page loaded, from any host, as the
 * browser received it. A loader kit keeps its code on a backend host, so
 * files are not judged by where they came from; urlscan rarity separates the
 * kit from the libraries it loads. Images are never used: stock logos and
 * icons are shared by unrelated sites. The capture bounds how many there are.
 */
export function kitFingerprints(resources: readonly WebsiteKitResource[]): KitFingerprint[] {
	const fingerprints = new Map<string, KitFingerprint>();
	for (const resource of resources) {
		const url = normalizePublicHttpUrl(resource.url);
		if (!url || !KIT_MIME_TYPES.has(resource.mimeType)) continue;
		if (resource.size < MIN_RESOURCE_BYTES || !/^[a-f0-9]{64}$/.test(resource.sha256)) continue;
		if (!fingerprints.has(resource.sha256)) fingerprints.set(resource.sha256, { sha256: resource.sha256, mimeType: resource.mimeType, url, size: resource.size });
	}
	return [...fingerprints.values()]
		.sort((a, b) => Number(isScript(b.mimeType)) - Number(isScript(a.mimeType)) || b.size - a.size || a.url.localeCompare(b.url));
}

async function loadSubmissionKitResources(submissionId: bigint): Promise<WebsiteKitResource[] | undefined> {
	const submission = await SubmissionsEntity.get(submissionId);
	return submission?.data.kind === "website" ? submission.data.website.kitResources : undefined;
}

async function searchUrlscan(fingerprint: KitFingerprint, apiKey: string | undefined, dependencies: SiblingDiscoveryDependencies) {
	const query = new URLSearchParams({
		q: `hash:${fingerprint.sha256} AND date:>now-90d`,
		// One past the rarity limit is enough to tell a kit file from a shared one.
		size: String(maxHashDomains(fingerprint.mimeType) + 1),
		collapse: "page.domain.keyword",
	});
	const response = await fetchJson<unknown>(`${URLSCAN_SEARCH_URL}?${query}`, {
		method: "GET",
		headers: {
			Accept: "application/json",
			...(apiKey ? { "API-Key": apiKey } : {}),
			"User-Agent": "phishing.support-origin-discovery/1.0 (+https://phishing.support)",
		},
	}, {
		fetch: dependencies.fetch,
		timeoutMs: 15_000,
		attempts: 2,
		retryDelayMs: 1_000,
		maxResponseBytes: 4 * 1024 * 1024,
	});
	const parsed = urlscanResponseSchema.safeParse(response);
	if (!parsed.success) throw new Error("urlscan returned an invalid search response.");
	return parsed.data;
}

/**
 * Find domains serving an exact copy of the kit's own files. A hash counts
 * only when it is rare on urlscan, and a candidate must share at least one
 * script: stylesheets alone are too often reused across unrelated templates.
 */
export async function findKitSiblingCandidates(params: {
	submissionId: bigint;
	originalDomain: string;
	signal?: AbortSignal;
}, dependencies: SiblingDiscoveryDependencies = {}): Promise<KitSiblingSearchResult> {
	const errors: string[] = [];
	const apiKey = dependencies.apiKey ?? process.env.URLSCAN_API_KEY;
	if (!apiKey) errors.push("URLSCAN_API_KEY is not configured; urlscan discovery used the anonymous quota.");
	const resources = await (dependencies.loadKitResources ?? loadSubmissionKitResources)(params.submissionId);
	if (!resources?.length) return { fingerprints: [], candidates: [], errors: ["The capture recorded no scripts or stylesheets."] };
	const fingerprints = kitFingerprints(resources);
	if (!fingerprints.some(({ mimeType }) => isScript(mimeType))) return { fingerprints, candidates: [], errors: [...errors, "The capture recorded no script large enough to identify a kit."] };

	const original = normalizeDomain(params.originalDomain);
	const candidates = new Map<string, { url: string; hashes: Set<string> }>();
	const scriptHashes = new Set<string>();
	for (const fingerprint of fingerprints) {
		throwIfAborted(params.signal);
		let results: Awaited<ReturnType<typeof searchUrlscan>>;
		try {
			results = await searchUrlscan(fingerprint, apiKey, dependencies);
		} catch (error) {
			if (error instanceof RequestTimeoutError || error instanceof RequestStatusError && (error.status === 429 || error.status >= 500)) throw error;
			errors.push(`urlscan ${fingerprint.sha256.slice(0, 12)}: ${errorSummary(error)}`);
			continue;
		}
		const domains = new Map<string, string>();
		for (const result of results.results) {
			const domain = normalizeDomain(result.page?.domain ?? result.task?.domain ?? "");
			if (!domain || domains.has(domain)) continue;
			const suppliedUrl = normalizePublicHttpUrl(result.page?.url ?? result.task?.url ?? "");
			domains.set(domain, suppliedUrl && new URL(suppliedUrl).hostname === domain ? suppliedUrl : `https://${domain}/`);
		}
		// More pages than the one requested means more domains than it could hold.
		if (results.has_more || domains.size > maxHashDomains(fingerprint.mimeType)) {
			errors.push(`urlscan ${fingerprint.sha256.slice(0, 12)}: seen on more than ${maxHashDomains(fingerprint.mimeType)} domains, treated as a shared library`);
			continue;
		}
		if (isScript(fingerprint.mimeType)) scriptHashes.add(fingerprint.sha256);
		for (const [domain, url] of domains) {
			if (domain === original || candidates.size >= MAX_CANDIDATES && !candidates.has(domain)) continue;
			const candidate = candidates.get(domain) ?? { url, hashes: new Set<string>() };
			candidate.hashes.add(fingerprint.sha256);
			candidates.set(domain, candidate);
		}
	}

	return {
		fingerprints,
		candidates: [...candidates]
			.map(([domain, candidate]) => ({ domain, url: candidate.url, matchingHashes: [...candidate.hashes] }))
			.filter((candidate) => candidate.matchingHashes.some((hash) => scriptHashes.has(hash))),
		errors,
	};
}

/** Find domains sharing captured kit bytes and prove they answer on the swept origin. */
export async function discoverSiblingDomains(params: {
	submissionId: bigint;
	originalDomain: string;
	originServers: readonly OriginServer[];
	signal?: AbortSignal;
}, dependencies: SiblingDiscoveryDependencies = {}): Promise<SiblingDiscoveryResult> {
	const searched = await findKitSiblingCandidates(params, dependencies);
	if (params.originServers.length === 0) {
		return { fingerprints: searched.fingerprints, candidateCount: searched.candidates.length, confirmed: [], errors: searched.errors };
	}
	const probe = dependencies.probe ?? presentedCertificate;
	const confirmed = await mapConcurrent(searched.candidates, 20, async (candidate) => {
		for (const server of params.originServers) {
			throwIfAborted(params.signal);
			const certificate = await probe(server.ip, candidate.domain, 2_000);
			if (certificate && certificateCovers(certificate.names, candidate.domain)) {
				return { ...candidate, originIp: server.ip, certificate } satisfies ConfirmedSiblingDomain;
			}
		}
		return undefined;
	});
	return {
		fingerprints: searched.fingerprints,
		candidateCount: searched.candidates.length,
		confirmed: confirmed.filter((candidate): candidate is ConfirmedSiblingDomain => Boolean(candidate)),
		errors: searched.errors,
	};
}

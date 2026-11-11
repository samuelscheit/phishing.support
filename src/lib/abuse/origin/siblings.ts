import { createHash } from "node:crypto";

import { z } from "zod";

import { SubmissionsEntity } from "../../db/entities";
import { fetchJson, RequestStatusError, RequestTimeoutError, type FetchImplementation } from "../../network/bounded_fetch";
import type { WebsiteHiddenFrame, WebsiteKitResource } from "../../website_types";
import { normalizeDomain, normalizePublicHttpUrl } from "../security";
import { throwIfAborted } from "../worker/shared";
import { withoutCdnInjections } from "./cdn_injections";
import { mapConcurrent } from "./concurrency";
import { MAX_KIT_FINGERPRINTS } from "./snapshot";
import { isPopularSite, loadPopularDomains, type PopularDomains } from "./popular_domains";
import { certificateCovers, presentedCertificate, type OriginServer, type PresentedCertificate, type TlsProbe } from "./sweep";
import { errorSummary } from "../../error_text";

const MAX_CANDIDATES = 100;
/** Below this, a file is too generic (a tracking snippet, a one-line loader) to identify a kit. */
const MIN_RESOURCE_BYTES = 1_024;
/**
 * A hash seen on more distinct domains than this is a shared library, theme
 * or framework file, not one operator's kit. Code (a script, or the document
 * of a frame no visitor sees, which is where an exploit loader lives) gets
 * the script limit. This is also what excludes CDN
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

/** `script` and `hidden_frame` are the kit's code; a stylesheet alone never identifies it. */
export type KitFingerprintKind = "script" | "stylesheet" | "hidden_frame";

export type KitFingerprint = {
	sha256: string;
	kind: KitFingerprintKind;
	url: string;
	size: number;
};

/** What a capture recorded that can identify its kit. */
export type KitCapture = { kitResources?: readonly WebsiteKitResource[]; hiddenFrames?: readonly WebsiteHiddenFrame[] };

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
	loadKitCapture?: (submissionId: bigint) => Promise<KitCapture | undefined>;
	loadPopularDomains?: () => Promise<PopularDomains>;
	probe?: TlsProbe;
};

const isCode = (kind: KitFingerprintKind) => kind !== "stylesheet";
const maxHashDomains = (kind: KitFingerprintKind) => isCode(kind) ? MAX_SCRIPT_HASH_DOMAINS : MAX_STYLESHEET_HASH_DOMAINS;

/**
 * A hidden frame's document as the browser received it and, when the CDN in
 * front of the site inserted its own tags, as the origin served it: the
 * copy on a host without that CDN has the second hash. The stored source is
 * whole only while it fits the capture's cap; a cut one gives only the first.
 */
function frameDocumentHashes(frame: WebsiteHiddenFrame): Array<{ sha256: string; size: number }> {
	const hashes = [{ sha256: frame.sha256, size: frame.size }];
	const document = Buffer.from(frame.source, "utf8");
	if (document.byteLength !== frame.size) return hashes;
	const origin = withoutCdnInjections(document);
	if (origin) hashes.push({ sha256: createHash("sha256").update(origin).digest("hex"), size: origin.byteLength });
	return hashes;
}

/**
 * Every script and stylesheet the captured page loaded, from any host, as the
 * browser received it, and the document of every frame no visitor sees,
 * where an exploit kit keeps its loader. A loader kit keeps its code on a
 * backend host, so files are not judged by where they came from; urlscan
 * rarity separates the kit from the libraries it loads. Images are never
 * used: stock logos and icons are shared by unrelated sites. The capture
 * bounds how many there are.
 */
export function kitFingerprints(capture: KitCapture): KitFingerprint[] {
	const fingerprints = new Map<string, KitFingerprint>();
	const add = (fingerprint: KitFingerprint) => {
		if (fingerprint.size < MIN_RESOURCE_BYTES || !/^[a-f0-9]{64}$/.test(fingerprint.sha256) || fingerprints.has(fingerprint.sha256)) return;
		fingerprints.set(fingerprint.sha256, fingerprint);
	};
	for (const resource of capture.kitResources ?? []) {
		const url = normalizePublicHttpUrl(resource.url);
		if (!url || !KIT_MIME_TYPES.has(resource.mimeType)) continue;
		add({ sha256: resource.sha256, kind: SCRIPT_MIME_TYPES.has(resource.mimeType) ? "script" : "stylesheet", url, size: resource.size });
	}
	for (const frame of capture.hiddenFrames ?? []) {
		const url = normalizePublicHttpUrl(frame.url);
		if (!url) continue;
		for (const { sha256, size } of frameDocumentHashes(frame)) add({ sha256, kind: "hidden_frame", url, size });
	}
	return [...fingerprints.values()]
		.sort((a, b) => Number(isCode(b.kind)) - Number(isCode(a.kind)) || b.size - a.size || a.url.localeCompare(b.url))
		.slice(0, MAX_KIT_FINGERPRINTS);
}

async function loadSubmissionKitCapture(submissionId: bigint): Promise<KitCapture | undefined> {
	const submission = await SubmissionsEntity.get(submissionId);
	return submission?.data.kind === "website" ? submission.data.website : undefined;
}

async function searchUrlscan(fingerprint: KitFingerprint, apiKey: string | undefined, dependencies: SiblingDiscoveryDependencies) {
	const query = new URLSearchParams({
		q: `hash:${fingerprint.sha256} AND date:>now-90d`,
		// One past the rarity limit is enough to tell a kit file from a shared one.
		size: String(maxHashDomains(fingerprint.kind) + 1),
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
 * piece of code: stylesheets alone are too often reused across unrelated
 * templates.
 */
export async function findKitSiblingCandidates(params: {
	submissionId: bigint;
	originalDomain: string;
	signal?: AbortSignal;
}, dependencies: SiblingDiscoveryDependencies = {}): Promise<KitSiblingSearchResult> {
	const errors: string[] = [];
	const apiKey = dependencies.apiKey ?? process.env.URLSCAN_API_KEY;
	if (!apiKey) errors.push("URLSCAN_API_KEY is not configured; urlscan discovery used the anonymous quota.");
	const capture = await (dependencies.loadKitCapture ?? loadSubmissionKitCapture)(params.submissionId);
	if (!capture?.kitResources?.length && !capture?.hiddenFrames?.length) return { fingerprints: [], candidates: [], errors: ["The capture recorded no scripts, stylesheets, or hidden frames."] };
	const fingerprints = kitFingerprints(capture);
	if (!fingerprints.some(({ kind }) => isCode(kind))) return { fingerprints, candidates: [], errors: [...errors, "The capture recorded no script or hidden frame large enough to identify a kit."] };

	const original = normalizeDomain(params.originalDomain);
	const candidates = new Map<string, { url: string; hashes: Set<string> }>();
	const codeHashes = new Set<string>();
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
		if (results.has_more || domains.size > maxHashDomains(fingerprint.kind)) {
			errors.push(`urlscan ${fingerprint.sha256.slice(0, 12)}: seen on more than ${maxHashDomains(fingerprint.kind)} domains, treated as a shared library`);
			continue;
		}
		if (isCode(fingerprint.kind)) codeHashes.add(fingerprint.sha256);
		for (const [domain, url] of domains) {
			if (domain === original || candidates.size >= MAX_CANDIDATES && !candidates.has(domain)) continue;
			const candidate = candidates.get(domain) ?? { url, hashes: new Set<string>() };
			candidate.hashes.add(fingerprint.sha256);
			candidates.set(domain, candidate);
		}
	}

	const sharingCode = [...candidates]
		.map(([domain, candidate]) => ({ domain, url: candidate.url, matchingHashes: [...candidate.hashes] }))
		.filter((candidate) => candidate.matchingHashes.some((hash) => codeHashes.has(hash)));
	// A clone kit copies the impersonated site's own files; that site shares
	// them but is the brand, never a sibling (x.com for an X clone).
	const popular = sharingCode.length ? await (dependencies.loadPopularDomains ?? loadPopularDomains)() : undefined;
	const brands = sharingCode.filter(({ domain }) => popular && isPopularSite(domain, popular));
	if (brands.length) errors.push(`${brands.map(({ domain }) => domain).join(", ")}: a top-ranked site (Tranco), the original the kit copied files from, not a sibling`);
	return { fingerprints, candidates: sharingCode.filter((candidate) => !brands.includes(candidate)), errors };
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

import { simpleParser } from "mailparser";
import { z } from "zod";

import { ArtifactsEntity } from "../../db/entities";
import { fetchJson, RequestStatusError, RequestTimeoutError, type FetchImplementation } from "../../network/bounded_fetch";
import { normalizeDomain, normalizePublicHttpUrl, sha256Hex } from "../security";
import { throwIfAborted } from "../worker/shared";
import { mapConcurrent } from "./concurrency";
import { certificateCovers, presentedCertificate, type OriginServer, type PresentedCertificate, type TlsProbe } from "./sweep";

const MAX_FINGERPRINTS = 5;
const MAX_CANDIDATES = 100;
const MIN_RESOURCE_BYTES = 1_024;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const URLSCAN_SEARCH_URL = "https://urlscan.io/api/v1/search/";
const STRONG_KIT_MIME_TYPES = new Set([
	"text/css",
	"text/javascript",
	"application/javascript",
	"application/x-javascript",
]);
const KIT_MIME_TYPES = new Set([
	...STRONG_KIT_MIME_TYPES,
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);

const urlscanResponseSchema = z.object({
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
	loadMhtml?: (submissionId: bigint) => Promise<Buffer | undefined>;
	probe?: TlsProbe;
};

/** Hash MIME-decoded resource bytes exactly as urlscan's HTTP-response `hash` field does. */
export async function kitFingerprintsFromMhtml(mhtml: Buffer, originalDomain: string): Promise<KitFingerprint[]> {
	const domain = normalizeDomain(originalDomain);
	if (!domain) return [];
	const parsed = await simpleParser(mhtml, { skipHtmlToText: true, skipTextToHtml: true });
	const fingerprints = new Map<string, KitFingerprint>();
	for (const attachment of parsed.attachments) {
		const mimeType = attachment.contentType?.split(";", 1)[0]?.trim().toLowerCase();
		if (!mimeType || !KIT_MIME_TYPES.has(mimeType)) continue;
		const location = attachment.headers.get("content-location");
		const url = normalizePublicHttpUrl(typeof location === "string" ? location : "");
		if (!url || new URL(url).hostname !== domain) continue;
		const body = attachment.content;
		if (body.byteLength < MIN_RESOURCE_BYTES || body.byteLength > MAX_RESOURCE_BYTES) continue;
		const sha256 = sha256Hex(body);
		if (!fingerprints.has(sha256)) fingerprints.set(sha256, { sha256, mimeType, url, size: body.byteLength });
	}
	return [...fingerprints.values()]
		.sort((a, b) => {
			const priority = (item: KitFingerprint) => item.mimeType.includes("javascript") ? 0 : item.mimeType === "text/css" ? 1 : 2;
			return priority(a) - priority(b) || b.size - a.size || a.url.localeCompare(b.url);
		})
		.slice(0, MAX_FINGERPRINTS);
}

async function loadSubmissionMhtml(submissionId: bigint): Promise<Buffer | undefined> {
	const metadata = await ArtifactsEntity.listForSubmission(submissionId);
	const item = metadata.find((artifact) => artifact.kind === "website_mhtml" || artifact.name?.toLowerCase() === "website.mhtml");
	return item ? (await ArtifactsEntity.get(item.id))?.blob : undefined;
}

async function searchUrlscan(hash: string, apiKey: string | undefined, dependencies: SiblingDiscoveryDependencies) {
	const query = new URLSearchParams({
		q: `hash:${hash} AND date:>now-90d`,
		size: "100",
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
	return parsed.data.results;
}

function detail(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500);
}

/** Find domains serving an exact hash of a same-host executable/style resource. */
export async function findKitSiblingCandidates(params: {
	submissionId: bigint;
	originalDomain: string;
	signal?: AbortSignal;
}, dependencies: SiblingDiscoveryDependencies = {}): Promise<KitSiblingSearchResult> {
	const errors: string[] = [];
	const apiKey = dependencies.apiKey ?? process.env.URLSCAN_API_KEY;
	if (!apiKey) errors.push("URLSCAN_API_KEY is not configured; urlscan discovery used the anonymous quota.");
	const mhtml = await (dependencies.loadMhtml ?? loadSubmissionMhtml)(params.submissionId);
	if (!mhtml?.byteLength) return { fingerprints: [], candidates: [], errors: ["The submission has no retained MHTML capture."] };
	let fingerprints: KitFingerprint[];
	try {
		fingerprints = await kitFingerprintsFromMhtml(mhtml, params.originalDomain);
	} catch (error) {
		return { fingerprints: [], candidates: [], errors: [`MHTML parsing: ${detail(error)}`] };
	}
	if (fingerprints.length === 0) return { fingerprints, candidates: [], errors };

	const original = normalizeDomain(params.originalDomain);
	const candidates = new Map<string, { url: string; hashes: Set<string> }>();
	for (const fingerprint of fingerprints) {
		throwIfAborted(params.signal);
		try {
			for (const result of await searchUrlscan(fingerprint.sha256, apiKey, dependencies)) {
				const domain = normalizeDomain(result.page?.domain ?? result.task?.domain ?? "");
				if (!domain || domain === original || candidates.size >= MAX_CANDIDATES && !candidates.has(domain)) continue;
				const suppliedUrl = normalizePublicHttpUrl(result.page?.url ?? result.task?.url ?? "");
				const url = suppliedUrl && new URL(suppliedUrl).hostname === domain ? suppliedUrl : `https://${domain}/`;
				const candidate = candidates.get(domain) ?? { url, hashes: new Set<string>() };
				candidate.hashes.add(fingerprint.sha256);
				candidates.set(domain, candidate);
			}
		} catch (error) {
			if (error instanceof RequestTimeoutError || error instanceof RequestStatusError && (error.status === 429 || error.status >= 500)) throw error;
			errors.push(`urlscan ${fingerprint.sha256.slice(0, 12)}: ${detail(error)}`);
		}
	}

	const strongHashes = new Set(fingerprints.filter(({ mimeType }) => STRONG_KIT_MIME_TYPES.has(mimeType)).map(({ sha256 }) => sha256));
	return {
		fingerprints,
		candidates: [...candidates]
			.map(([domain, candidate]) => ({ domain, url: candidate.url, matchingHashes: [...candidate.hashes] }))
			.filter((candidate) => candidate.matchingHashes.length >= 2 || candidate.matchingHashes.some((hash) => strongHashes.has(hash))),
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

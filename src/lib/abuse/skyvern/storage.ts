import { isIP } from "node:net";

import { assertPublicDnsHost, isPublicIp, normalizeDomain } from "../security";
import { asString } from "./contracts";

const MAX_SKYVERN_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_REDIRECTS = 3;

/**
 * The Compose-only MinIO endpoint is intentionally private. Skyvern must be
 * able to hand its own browser a presigned URL for that endpoint, so HTTP is
 * accepted only when it exactly matches this explicit, operations-owned
 * origin. Every other upload/artifact URL must remain HTTPS.
 */
function configuredInternalArtifactOrigin(): URL | undefined {
	const configured = process.env.SKYVERN_INTERNAL_S3_ORIGIN?.trim();
	if (!configured) return undefined;
	let origin: URL;
	try {
		origin = new URL(configured);
	} catch {
		throw new Error("SKYVERN_INTERNAL_S3_ORIGIN is invalid.");
	}
	if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
		throw new Error("SKYVERN_INTERNAL_S3_ORIGIN must be an HTTP(S) origin without credentials or a path.");
	}
	return origin;
}

function isConfiguredInternalArtifactOrigin(url: URL): boolean {
	const origin = configuredInternalArtifactOrigin();
	return Boolean(origin && url.origin === origin.origin);
}

export function urlHostname(url: URL): string {
	// WHATWG URL exposes IPv6 hostnames with brackets. Node's `isIP` expects
	// the literal without brackets, so normalize only at the URL boundary.
	return url.hostname.replace(/^\[|\]$/g, "");
}

function hasSafePublicStorageHost(url: URL): boolean {
	const hostname = urlHostname(url);
	return isIP(hostname) ? isPublicIp(hostname) : Boolean(normalizeDomain(hostname));
}

export function ensureSkyvernStorageUrl(value: unknown, label: string): string {
	const url = asString(value);
	if (!url) throw new Error(`Skyvern did not return a ${label} URL.`);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Skyvern returned an unsafe ${label} URL.`);
	}
	const internalOrigin = isConfiguredInternalArtifactOrigin(parsed);
	if (
		parsed.username
		|| parsed.password
		|| parsed.hash
		|| (parsed.protocol !== "https:" && !internalOrigin)
		|| (!internalOrigin && !hasSafePublicStorageHost(parsed))
	) {
		throw new Error(`Skyvern returned an unsafe ${label} URL.`);
	}
	return parsed.toString();
}

/**
 * A task may be resumed from a durable pre-task payload. Revalidate a stored
 * SDK URL before it is ever placed back into a browser instruction so a
 * corrupt record cannot turn into a new network destination.
 */
export function isSafeSkyvernStorageUrl(value: unknown): value is string {
	try {
		ensureSkyvernStorageUrl(value, "stored SDK upload");
		return true;
	} catch {
		return false;
	}
}

export function safeArtifactUrl(value: unknown): URL {
	return new URL(ensureSkyvernStorageUrl(value, "artifact retrieval"));
}

export async function fetchSkyvernArtifact(urlValue: string): Promise<{ body: Buffer; mimeType?: string }> {
	let url = safeArtifactUrl(urlValue);
	for (let redirects = 0; redirects <= MAX_ARTIFACT_REDIRECTS; redirects++) {
		// `skyvern-minio` is a code-owned private Compose service. It is the
		// only private endpoint allowed through this importer; a URL from any
		// other origin still receives full DNS/SSRF validation on every hop.
		if (!isConfiguredInternalArtifactOrigin(url)) await assertPublicDnsHost(urlHostname(url));
		const response = await fetch(url, { redirect: "manual" });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error("Skyvern artifact redirect had no location.");
			url = safeArtifactUrl(new URL(location, url).toString());
			continue;
		}
		if (!response.ok) throw new Error(`Skyvern artifact fetch failed with HTTP ${response.status}.`);
		const declaredLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > MAX_SKYVERN_ARTIFACT_BYTES) {
			throw new Error("Skyvern artifact exceeds the permanent-import size limit.");
		}
		const body = Buffer.from(await response.arrayBuffer());
		if (body.byteLength > MAX_SKYVERN_ARTIFACT_BYTES) throw new Error("Skyvern artifact exceeds the permanent-import size limit.");
		return { body, mimeType: response.headers.get("content-type")?.split(";", 1)[0] ?? undefined };
	}
	throw new Error("Skyvern artifact exceeded the redirect limit.");
}

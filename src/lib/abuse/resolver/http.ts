import { AbuseInputError, assertPublicDnsHost } from "../security";
import { asRecord } from "./records";
import type { JsonRecord, ResolverDependencies } from "./types";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_HTTP_TIMEOUT_MS = 12_000;

type JsonRequestResult =
	| { kind: "redirect"; location: string }
	| { kind: "result"; value: JsonRecord | undefined };

function responseError(url: URL, response: Response): Error {
	return new Error(`Resolver request to ${url.hostname} failed with HTTP ${response.status}.`);
}

async function responseBody(response: Response): Promise<Buffer> {
	const contentLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) throw new Error("Resolver response exceeded its size limit.");
	if (!response.body) return Buffer.alloc(0);

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			size += value.byteLength;
			if (size > MAX_JSON_BYTES) {
				void reader.cancel();
				throw new Error("Resolver response exceeded its size limit.");
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, size);
}

async function responseJson(response: Response, url: URL): Promise<JsonRecord | undefined> {
	if (response.status === 404) return undefined;
	if (!response.ok) throw responseError(url, response);
	const body = await responseBody(response);
	try {
		return asRecord(JSON.parse(body.toString("utf8")));
	} catch {
		throw new Error(`Resolver response from ${url.hostname} was not valid JSON.`);
	}
}

function timeoutMs(dependencies: ResolverDependencies): number {
	const configured = dependencies.httpTimeoutMs;
	return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HTTP_TIMEOUT_MS;
}

async function requestJson(url: URL, dependencies: ResolverDependencies): Promise<JsonRequestResult> {
	const fetchImplementation = dependencies.fetch ?? fetch;
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			controller.abort();
			reject(new Error("Resolver HTTP request timed out."));
		}, timeoutMs(dependencies));
	});
	try {
		return await Promise.race([
			(async () => {
				const response = await fetchImplementation(url, {
					method: "GET",
					redirect: "manual",
					headers: { Accept: "application/rdap+json, application/json;q=0.9" },
					signal: controller.signal,
				});
				if (response.status >= 300 && response.status < 400) {
					const location = response.headers.get("location");
					if (!location) throw new Error("Resolver received a redirect without a location.");
					return { kind: "redirect" as const, location };
				}
				return { kind: "result" as const, value: await responseJson(response, url) };
			})(),
			deadline,
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

/** Fetch an RDAP/RIPE endpoint while enforcing the resolver's SSRF contract. */
export async function safeJsonFetch(urlValue: string, dependencies: ResolverDependencies): Promise<JsonRecord | undefined> {
	const assertHost = dependencies.assertPublicHost ?? assertPublicDnsHost;
	let url = new URL(urlValue);
	for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
		if (url.protocol !== "https:" || url.username || url.password || url.port) {
			throw new AbuseInputError("Resolver attempted an unsafe RDAP endpoint.");
		}
		await assertHost(url.hostname);
		const result = await requestJson(url, dependencies);
		if (result.kind === "redirect") {
			url = new URL(result.location, url);
			continue;
		}
		return result.value;
	}
	throw new Error("Resolver exceeded its redirect limit.");
}

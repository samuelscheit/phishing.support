import sharp from "sharp";

import { assertPublicDnsHost } from "../abuse/security/security";
import type { FaviconDependencies } from "./extract";

/** A real raster of `width`×`height` pixels in one colour. */
export async function raster(format: "png" | "gif" | "jpeg" | "webp", width: number, height = width, colour = "#f38020"): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 4, background: colour } }).toFormat(format).toBuffer();
}

/** What a scripted server answers: bytes with a status and headers, a redirect, or a failure to connect. */
export type Answer = { status?: number; body?: string | Buffer; headers?: Record<string, string> } | { redirect: string } | { error: string };

/**
 * A scripted web for the fetches of one test: each URL answers as `site`
 * says (404 for any other), every request is recorded, and every hostname
 * resolves to a public address except the names in `privateHosts`, through
 * the service's own public-address check.
 */
export function scriptedWeb(site: Record<string, Answer>, privateHosts: readonly string[] = []) {
	const requests: Array<{ url: string; headers: Record<string, string> }> = [];
	const dependencies: FaviconDependencies = {
		fetch: async (input, init) => {
			const url = String(input);
			requests.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
			const answer = site[url] ?? { status: 404, body: "<html>Not found</html>" };
			if ("error" in answer) throw new TypeError(answer.error);
			if ("redirect" in answer) return new Response(null, { status: 302, headers: { location: answer.redirect } });
			return new Response(typeof answer.body === "string" ? answer.body : answer.body ? new Uint8Array(answer.body) : null, { status: answer.status ?? 200, headers: answer.headers ?? {} });
		},
		assertPublicHost: (hostname) => assertPublicDnsHost(hostname, (async (name: string) => [{ address: privateHosts.includes(name) ? "10.0.0.5" : "93.184.216.34", family: 4 }]) as never),
	};
	return { dependencies, requests, urls: () => requests.map(({ url }) => url) };
}

export const html = (head: string) => ({ body: `<!doctype html><html><head><title>Home</title>${head}</head><body>Home</body></html>`, headers: { "content-type": "text/html; charset=utf-8" } });

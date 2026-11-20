import { TUCOWS_PROVIDER } from "./definition";
import { unescapeHtml } from "../../../util/html";
import { deadline } from "../../../util/async";
import { type FetchLike } from "../../../http/fetch";

/** One answer: the status, the redirect it names, and the body. */
export type TucowsReply = { status: number; location?: string; text: string };

/**
 * One visitor session on Tucows' wizard. Bullwark keeps its state server-side
 * behind the cookies `_swb` and `csrf_token` and moves between steps by 303
 * redirects, so redirects are read, not followed, and cookies are kept here.
 */
export type TucowsSession = {
	get(path: string): Promise<TucowsReply>;
	postForm(path: string, fields: Record<string, string>): Promise<TucowsReply>;
	postJson(path: string, body: Record<string, string>, csrfToken: string): Promise<TucowsReply>;
	postMultipart(path: string, form: FormData): Promise<TucowsReply>;
};

/** The value of the `<input name="csrf_token">` of a page; its attributes may come in either order. */
export function hiddenCsrfToken(html: string): string | undefined {
	for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
		if (!/\bname\s*=\s*["']csrf_token["']/i.test(tag)) continue;
		const value = /\bvalue\s*=\s*"([^"]*)"|\bvalue\s*=\s*'([^']*)'/i.exec(tag);
		const token = value?.[1] ?? value?.[2];
		if (token) return unescapeHtml(token);
	}
	return undefined;
}

/** The `<meta name="csrf-token">` the page's own JSON calls send as `X-CSRF-Token`. */
export function metaCsrfToken(html: string): string | undefined {
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		if (!/\bname\s*=\s*["']csrf-token["']/i.test(tag)) continue;
		const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
		const token = content?.[1] ?? content?.[2];
		if (token) return unescapeHtml(token);
	}
	return undefined;
}

export function createTucowsSession(fetchImplementation: FetchLike, signal?: AbortSignal): TucowsSession {
	const cookies = new Map<string, string>();
	const absolute = (path: string) => new URL(path, TUCOWS_PROVIDER.origin).toString();
	async function send(path: string, init: { method: string; headers: Record<string, string>; body?: string | FormData }): Promise<TucowsReply> {
		const headers: Record<string, string> = { ...init.headers, origin: TUCOWS_PROVIDER.origin, referer: TUCOWS_PROVIDER.reportUrl };
		if (cookies.size > 0) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
		const response = await fetchImplementation(absolute(path), {
			...init,
			headers,
			redirect: "manual",
			signal: deadline(TUCOWS_PROVIDER.timeoutMs, signal),
		});
		for (const line of response.headers.getSetCookie()) {
			const pair = line.split(";", 1)[0]!;
			const separator = pair.indexOf("=");
			if (separator <= 0) continue;
			const name = pair.slice(0, separator).trim();
			const value = pair.slice(separator + 1).trim();
			if (!value || /;\s*max-age=0\b/i.test(line)) cookies.delete(name);
			else cookies.set(name, value);
		}
		return { status: response.status, ...(response.headers.get("location") ? { location: response.headers.get("location")! } : {}), text: await response.text() };
	}
	return {
		get: (path) => send(path, { method: "GET", headers: { accept: "text/html,application/xhtml+xml" } }),
		postForm: (path, fields) => send(path, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html,application/xhtml+xml" },
			body: new URLSearchParams(fields).toString(),
		}),
		postJson: (path, body, csrfToken) => send(path, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "x-csrf-token": csrfToken },
			body: new URLSearchParams(body).toString(),
		}),
		postMultipart: (path, form) => send(path, { method: "POST", headers: { accept: "text/html,application/xhtml+xml" }, body: form }),
	};
}

/** The path a redirect names, whatever its form (relative, absolute); undefined for another host. */
export function redirectPath(reply: TucowsReply): string | undefined {
	if (reply.status < 300 || reply.status >= 400 || !reply.location) return undefined;
	try {
		const url = new URL(reply.location, TUCOWS_PROVIDER.origin);
		return url.origin === TUCOWS_PROVIDER.origin ? `${url.pathname}${url.search}` : undefined;
	} catch {
		return undefined;
	}
}


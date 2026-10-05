import crypto from "node:crypto";

export type BrowserProxy = {
	server: string;
	username?: string;
	password?: string;
};

/** One parsed outbound proxy configuration shared by direct report providers. */
export type ProviderProxy = {
	url: string;
	browser: BrowserProxy;
	captchaType: "HTTP" | "SOCKS4" | "SOCKS5";
};

function decodeCredential(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new Error("PROXY_URL contains invalid URL-encoded credentials.");
	}
}

/**
 * Parse the one outbound proxy setting used by browser, HTTP, and CAPTCHA
 * clients. Credentials remain in memory only and are never written into a
 * durable provider payload.
 */
export function parseProviderProxy(value: string): ProviderProxy {
	const url = value.trim().replace(/^socks5h:/i, "socks5:");

	let proxy: URL;
	try {
		proxy = new URL(url);
	} catch {
		throw new Error("PROXY_URL must be a valid HTTP, HTTPS, SOCKS4, or SOCKS5 proxy URL.");
	}

	const protocol = proxy.protocol.toLowerCase();
	if (!proxy.hostname || !["http:", "https:", "socks4:", "socks5:"].includes(protocol)) {
		throw new Error("PROXY_URL must use HTTP, HTTPS, SOCKS4, or SOCKS5 and include a proxy host.");
	}

	const browser: BrowserProxy = { server: `${protocol}//${proxy.host}` };
	if (proxy.username || proxy.password) {
		browser.username = decodeCredential(proxy.username);
		browser.password = decodeCredential(proxy.password);
	}

	return {
		url,
		browser,
		captchaType: protocol === "socks5:" ? "SOCKS5" : protocol === "socks4:" ? "SOCKS4" : "HTTP",
	};
}

/** Read the shared outbound proxy setting before crossing a provider boundary. */
export function getProviderProxy(integration: string): ProviderProxy {
	const value = process.env.PROXY_URL;
	if (!value?.trim()) throw new Error(`${integration} requires PROXY_URL to be configured.`);
	return parseProviderProxy(value);
}

function isIproyalHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return normalized === "iproyal.com" || normalized.endsWith(".iproyal.com") || normalized === "iproyal.net" || normalized.endsWith(".iproyal.net");
}

/**
 * Give IPRoyal's rotating residential gateway a stable per-operation exit
 * IP. Death by Captcha binds a token to the proxy identity that solves it;
 * using the gateway's default per-request rotation lets the browser and the
 * solver receive different IPs and guarantees rejection. IPRoyal encodes the
 * session in the password as `_session-<id>`.
 */
export function withIproyalStickySession(proxy: ProviderProxy, sessionId = crypto.randomBytes(12).toString("hex")): ProviderProxy {
	const parsed = new URL(proxy.url);
	if (!isIproyalHostname(parsed.hostname)) return proxy;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error("IPRoyal proxy session ID is invalid.");
	if (!parsed.password) throw new Error("IPRoyal sticky sessions require proxy password authentication.");
	const password = decodeCredential(parsed.password).replace(/_session-[A-Za-z0-9-]+(?=_|$)/i, "");
	parsed.password = `${password}_session-${sessionId}`;
	return parseProviderProxy(parsed.toString());
}

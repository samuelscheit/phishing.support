export type BrowserProxy = {
	server: string;
	username?: string;
	password?: string;
};

export type ReportProxy = {
	url: string;
	browser: BrowserProxy;
	captchaType: "HTTP" | "SOCKS4" | "SOCKS5";
};

function decodeCredential(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new Error("PROXY_URL contains invalid URL-encoded credentials.");
	}
}

export function parseReportProxy(value: string): ReportProxy {
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

	const browser: BrowserProxy = {
		server: `${protocol}//${proxy.host}`,
	};

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

export function getReportProxy(integration: string) {
	const value = process.env.PROXY_URL;
	if (!value?.trim()) {
		throw new Error(`${integration} requires PROXY_URL to be configured.`);
	}

	return parseReportProxy(value);
}

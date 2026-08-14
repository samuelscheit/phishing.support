import { normalizeDomain, registrableDomain } from "../security";

/** Rollout gates are code-owned; SMTP configuration alone never enables a route. */
export function isGenericEmailRouteEnabled(): boolean {
	return process.env.ABUSE_GENERIC_EMAIL_ENABLED === "true";
}

/** For an explicit abuse mailbox, its registrable provider domain is the verified web boundary. */
export function verifiedDomainsForEmailRoute(email: string): string[] {
	const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
	const root = registrableDomain(domain);
	return root ? [root] : [];
}

/** Validates an explicit email-route link against only its verified domains. */
export function isVerifiedEmailRouteOriginAllowed(verifiedDomains: string[], url: URL): boolean {
	if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
	const host = normalizeDomain(url.hostname);
	if (!host) return false;
	return verifiedDomains.some((domain) => {
		const normalized = normalizeDomain(domain);
		return Boolean(normalized && (host === normalized || host.endsWith(`.${normalized}`)));
	});
}

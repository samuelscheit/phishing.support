import { normalizeDomain } from "../../security";

/** Validate an evidence URL before browser navigation under GNAME's policy. */
export function publicGnameEvidenceHost(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Evidence URL must use HTTP or HTTPS.");
	if (parsed.username || parsed.password || parsed.port) throw new Error("Evidence URL contains unsupported credentials or port.");
	const hostname = normalizeDomain(parsed.hostname);
	if (!hostname) throw new Error("Evidence URL host is not a public domain.");
	return hostname;
}

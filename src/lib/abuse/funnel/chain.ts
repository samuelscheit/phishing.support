import type { WebsiteNavigationHop } from "../../website/types";
import type { PageScreenshot } from "../linked_host_report";
import { registrableDomain } from "../security/security";

/**
 * One navigation response of a case's chain, as the visit recorded it; `at`
 * is when the response arrived, when the visit timed it.
 */
export type FunnelHop = Pick<WebsiteNavigationHop, "index" | "url" | "hostname" | "status" | "redirectTo"> & { at?: Date };

/** A page the chain showed: the hop that served it, its visible text and its (stamped) screenshot. */
export type FunnelPage = {
	hopIndex: number;
	url: string;
	title?: string;
	text: string;
	screenshot?: PageScreenshot;
	capturedAt: Date;
};

/** Everything one case recorded of a redirect chain, in navigation order. */
export type FunnelChain = {
	hops: readonly FunnelHop[];
	pages: readonly FunnelPage[];
	startedAt: Date;
};

/** The business a host belongs to: its registrable domain (`www.zatos.com` → `zatos.com`). */
export function businessSite(hostname: string): string {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	return registrableDomain(host) ?? host;
}

export function parsedUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

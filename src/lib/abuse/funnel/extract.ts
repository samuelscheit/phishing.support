import { businessSite, parsedUrl, type FunnelChain } from "./chain";
import {
	confidenceRank,
	genericIdentifiers,
	identifierValue,
	landingIdentifiers,
	recogniseTracker,
	strongerConfidence,
	type Confidence,
	type FunnelIdentifier,
	type FunnelPlatform,
	type TrackerMatch,
} from "./platforms";
import { wrappedUrls, type WrapperEncoding } from "./wrappers";

/** What a hop of the chain is to the funnel. */
type FunnelHopKind = "tracker" | "redirector" | "lure" | "merchant" | "redirect";

type TrackingHop = TrackerMatch & {
	/** The hop that requested this URL, or that carried it when it was never requested itself. */
	hopIndex: number;
	url: string;
	hostname: string;
	site: string;
	/** Set when the visit never requested this URL: a wrapper parameter or a redirect's `Location` carried it. */
	carriedBy?: { parameter: string; encoding: WrapperEncoding | "location" };
};

/** A hop that only forwards the visitor to the URL one of its parameters carries. */
type FunnelRedirector = { hopIndex: number; url: string; site: string; parameter: string; encoding: WrapperEncoding; target: string };

/** The paid offer the chain ends on, and the affiliate parameters its landing URL received. */
type FunnelMerchant = {
	hopIndex: number;
	url: string;
	hostname: string;
	site: string;
	identifiers: Array<FunnelIdentifier & { confidence: Confidence }>;
};

/** An affiliate ID as one business (`site`) knows it. */
type FunnelAffiliate = {
	id: string;
	site: string;
	/** The tracking platform whose link carried it; absent on the merchant's own landing URL. */
	platform?: FunnelPlatform;
	parameter: string;
	hopIndices: number[];
	confidence: Confidence;
	/** Other businesses of the chain that carry the same ID: the network passed its affiliate on. */
	matchedAt: string[];
};

/** A business that can terminate the affiliate: the merchant, or the operator of a network tracking domain. */
export type FunnelParty = {
	role: "merchant" | "network";
	site: string;
	hostnames: string[];
	platform?: FunnelPlatform;
	/** Strongest first. */
	affiliateIds: string[];
	hopIndices: number[];
};

/** A value the chain carried from one business to the next (a sub ID, a click ID), linking their hops. */
type CarriedValue = { value: string; seenAt: Array<{ hopIndex: number; site: string; parameter: string }> };

export type FunnelExtraction = {
	hopKinds: Array<{ hopIndex: number; kind: FunnelHopKind }>;
	trackingHops: TrackingHop[];
	redirectors: FunnelRedirector[];
	merchant?: FunnelMerchant;
	/** Hops of the pages shown before the merchant that are neither trackers nor the merchant's. */
	lurePageHops: number[];
	affiliates: FunnelAffiliate[];
	parties: FunnelParty[];
	carriedValues: CarriedValue[];
};

const MAX_CARRIED_VALUES = 12;
const MAX_CARRIED_DEPTH = 3;
const UNINFORMATIVE_VALUE = /^(?:true|false|null|undefined|none|unknown|default)$/i;

type Located = { hopIndex: number; url: URL };

/**
 * Tracking links a URL carries without the visit requesting them: a
 * wrapper's encoded target (`/redirect?target=BASE64…`), a deep link, or a
 * redirect whose `Location` the visit never followed.
 */
function carriedTrackers(hopIndex: number, carried: Array<{ parameter: string; encoding: WrapperEncoding | "location"; url: string }>, requested: ReadonlySet<string>, depth = 0): TrackingHop[] {
	if (depth >= MAX_CARRIED_DEPTH) return [];
	return carried.flatMap((item) => {
		const url = parsedUrl(item.url);
		if (!url || requested.has(url.toString())) return [];
		const found = recogniseTracker(url);
		const own: TrackingHop[] = found
			? [{ ...found, hopIndex, url: url.toString(), hostname: url.hostname, site: businessSite(url.hostname), carriedBy: { parameter: item.parameter, encoding: item.encoding } }]
			: [];
		return [...own, ...carriedTrackers(hopIndex, wrappedUrls(url), requested, depth + 1)];
	});
}

function mergeAffiliate(into: Map<string, FunnelAffiliate>, affiliate: Omit<FunnelAffiliate, "matchedAt">): void {
	const key = `${affiliate.site}\u0000${affiliate.id}`;
	const existing = into.get(key);
	if (!existing) {
		into.set(key, { ...affiliate, matchedAt: [] });
		return;
	}
	existing.hopIndices = [...new Set([...existing.hopIndices, ...affiliate.hopIndices])].sort((a, b) => a - b);
	existing.confidence = strongerConfidence(existing.confidence, affiliate.confidence);
	existing.platform ??= affiliate.platform;
}

function carriedValues(located: Located[]): CarriedValue[] {
	const byValue = new Map<string, CarriedValue["seenAt"]>();
	for (const { hopIndex, url } of located) {
		const site = businessSite(url.hostname);
		for (const [parameter, raw] of url.searchParams) {
			const value = identifierValue(raw);
			if (!value || value.length < 4 || UNINFORMATIVE_VALUE.test(value) || /^https?:/i.test(value)) continue;
			const seen = byValue.get(value) ?? [];
			if (!seen.some((item) => item.site === site && item.parameter === parameter)) seen.push({ hopIndex, site, parameter });
			byValue.set(value, seen);
		}
	}
	return [...byValue]
		.filter(([, seenAt]) => new Set(seenAt.map(({ site }) => site)).size >= 2)
		.map(([value, seenAt]) => ({ value, seenAt }))
		.sort((a, b) => a.seenAt[0]!.hopIndex - b.seenAt[0]!.hopIndex)
		.slice(0, MAX_CARRIED_VALUES);
}

/**
 * Reads a recorded redirect chain as an affiliate funnel: which hops are
 * tracking links of which platform and what they carry, which only wrap the
 * next URL, which pages lured the visitor, which paid offer it ended on, and
 * the affiliate IDs as each business in the chain knows them. Pure: it reads
 * URLs only and fetches nothing.
 */
export function extractFunnel(chain: Pick<FunnelChain, "hops" | "pages">): FunnelExtraction {
	const hops = [...chain.hops]
		.sort((a, b) => a.index - b.index)
		.flatMap((hop) => {
			const url = parsedUrl(hop.url);
			return url ? [{ hop, url, site: businessSite(url.hostname) }] : [];
		});
	const shown = new Set(chain.pages.map((page) => page.hopIndex));
	const requested = new Set(hops.map(({ url }) => url.toString()));
	const kinds = new Map<number, FunnelHopKind>();
	const trackingHops: TrackingHop[] = [];
	const redirectors: FunnelRedirector[] = [];

	for (const { hop, url, site } of hops) {
		const isShown = shown.has(hop.index);
		const found = recogniseTracker(url);
		// A page the visitor was shown is a tracker only when its URL leaves no doubt.
		if (found && (!isShown || found.confidence === "high")) {
			trackingHops.push({ ...found, hopIndex: hop.index, url: url.toString(), hostname: url.hostname, site });
			kinds.set(hop.index, "tracker");
		}
		const wrapped = wrappedUrls(url);
		const location = hop.redirectTo ? [{ parameter: "Location", encoding: "location" as const, url: hop.redirectTo }] : [];
		trackingHops.push(...carriedTrackers(hop.index, [...wrapped, ...location], requested));
		if (kinds.has(hop.index) || isShown) continue;
		if (wrapped[0]) {
			redirectors.push({ hopIndex: hop.index, url: url.toString(), site, parameter: wrapped[0].parameter, encoding: wrapped[0].encoding, target: wrapped[0].url });
			kinds.set(hop.index, "redirector");
			continue;
		}
		const affiliateParameters = genericIdentifiers(url).filter((identifier) => identifier.kind === "affiliate" && identifier.confidence !== "low");
		if (affiliateParameters.length) {
			trackingHops.push({
				platform: "affiliate_link",
				role: "network",
				confidence: "low",
				signals: [`affiliate parameter ${affiliateParameters.map(({ parameter, value }) => `${parameter}=${value}`).join(", ")} on a redirect`],
				identifiers: genericIdentifiers(url).map(({ confidence: _confidence, ...identifier }) => identifier),
				hopIndex: hop.index,
				url: url.toString(),
				hostname: url.hostname,
				site,
			});
			kinds.set(hop.index, "tracker");
		}
	}

	const requestedTrackers = trackingHops.filter((tracker) => !tracker.carriedBy);
	const lastPage = hops.findLast(({ hop }) => shown.has(hop.index) && kinds.get(hop.index) !== "tracker");
	const lastTrackerBefore = lastPage && requestedTrackers.findLast((tracker) => tracker.hopIndex < lastPage.hop.index);
	let merchant: FunnelMerchant | undefined;
	if (lastPage && lastTrackerBefore) {
		const landing = hops.filter(({ hop, site }) => hop.index > lastTrackerBefore.hopIndex && hop.index <= lastPage.hop.index && site === lastPage.site);
		const first = landing[0] ?? lastPage;
		const identifiers = landing
			.flatMap(({ url }) => landingIdentifiers(url))
			.filter((identifier, index, all) => all.findIndex((other) => other.parameter === identifier.parameter && other.value === identifier.value) === index);
		merchant = { hopIndex: first.hop.index, url: first.url.toString(), hostname: first.url.hostname, site: lastPage.site, identifiers };
		for (const { hop } of landing) kinds.set(hop.index, "merchant");
		kinds.set(lastPage.hop.index, "merchant");
	}
	const lurePageHops = hops
		.filter(({ hop, site }) => shown.has(hop.index) && kinds.get(hop.index) !== "tracker" && kinds.get(hop.index) !== "merchant" && (!merchant || (hop.index < merchant.hopIndex && site !== merchant.site)))
		.map(({ hop }) => hop.index);
	for (const index of lurePageHops) kinds.set(index, "lure");

	const affiliateMap = new Map<string, FunnelAffiliate>();
	for (const tracker of trackingHops) {
		if (tracker.role !== "network") continue;
		for (const identifier of tracker.identifiers) {
			if (identifier.kind !== "affiliate") continue;
			mergeAffiliate(affiliateMap, { id: identifier.value, site: tracker.site, platform: tracker.platform, parameter: identifier.parameter, hopIndices: [tracker.hopIndex], confidence: tracker.confidence });
		}
	}
	for (const identifier of merchant?.identifiers ?? []) {
		if (identifier.kind !== "affiliate") continue;
		mergeAffiliate(affiliateMap, { id: identifier.value, site: merchant!.site, parameter: identifier.parameter, hopIndices: [merchant!.hopIndex], confidence: identifier.confidence });
	}
	const affiliates = [...affiliateMap.values()].sort((a, b) => a.hopIndices[0]! - b.hopIndices[0]!);
	for (const affiliate of affiliates) {
		affiliate.matchedAt = [...new Set(affiliates.filter((other) => other.id === affiliate.id && other.site !== affiliate.site).map((other) => other.site))];
		// The same ID on the tracker and on the next business proves both read it as the affiliate.
		if (affiliate.matchedAt.length) affiliate.confidence = "high";
	}

	const parties: FunnelParty[] = [];
	const idsAt = (site: string) => affiliates
		.filter((affiliate) => affiliate.site === site)
		.sort((a, b) => confidenceRank(a.confidence) - confidenceRank(b.confidence) || a.hopIndices[0]! - b.hopIndices[0]!)
		.map((affiliate) => affiliate.id);
	const networkSites = [...new Set(trackingHops.filter((tracker) => tracker.role === "network").map((tracker) => tracker.site))];
	for (const site of networkSites) {
		if (site === merchant?.site) continue;
		const atSite = trackingHops.filter((tracker) => tracker.role === "network" && tracker.site === site);
		const strongest = [...atSite].sort((a, b) => confidenceRank(a.confidence) - confidenceRank(b.confidence))[0]!;
		parties.push({
			role: "network",
			site,
			hostnames: [...new Set(atSite.map((tracker) => tracker.hostname))],
			platform: strongest.platform,
			affiliateIds: idsAt(site),
			hopIndices: [...new Set(atSite.map((tracker) => tracker.hopIndex))],
		});
	}
	if (merchant) {
		const ownTracker = trackingHops.find((tracker) => tracker.role === "network" && tracker.site === merchant.site);
		const deliveredBy = parties.findLast((party) => party.hopIndices.some((index) => index < merchant.hopIndex));
		const own = idsAt(merchant.site);
		parties.unshift({
			role: "merchant",
			site: merchant.site,
			hostnames: [...new Set(hops.filter(({ site }) => site === merchant.site).map(({ url }) => url.hostname))],
			...(ownTracker ? { platform: ownTracker.platform } : {}),
			affiliateIds: own.length ? own : deliveredBy?.affiliateIds ?? [],
			hopIndices: hops.filter(({ site }) => site === merchant.site).map(({ hop }) => hop.index),
		});
	}

	const located: Located[] = [
		...hops.map(({ hop, url }) => ({ hopIndex: hop.index, url })),
		...trackingHops.filter((tracker) => tracker.carriedBy).map((tracker) => ({ hopIndex: tracker.hopIndex, url: new URL(tracker.url) })),
	];
	return {
		hopKinds: hops.map(({ hop }) => ({ hopIndex: hop.index, kind: kinds.get(hop.index) ?? "redirect" })),
		trackingHops,
		redirectors,
		...(merchant ? { merchant } : {}),
		lurePageHops,
		affiliates,
		parties,
		carriedValues: carriedValues(located),
	};
}

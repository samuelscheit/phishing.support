import { businessSite, isPlatformHost, parsedUrl, type FunnelChain } from "./chain";
import {
	confidenceRank,
	identifierValue,
	landingIdentifiers,
	recogniseTracker,
	strongerConfidence,
	weakerConfidence,
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
	/** Set when the visit never requested this URL: a redirect's parameter or `Location` carried it. */
	carriedBy?: { parameter: string; encoding: WrapperEncoding | "location" };
};

/** A hop that only forwards the visitor to the URL one of its parameters carries. */
type FunnelRedirector = { hopIndex: number; url: string; site: string; parameter: string; encoding: WrapperEncoding; target: string };

/** The paid offer the chain ends on, and the parameters its landing URL received. */
type FunnelMerchant = {
	hopIndex: number;
	url: string;
	hostname: string;
	site: string;
	identifiers: Array<FunnelIdentifier & { confidence: Confidence }>;
};

/** An affiliate ID as one business (`site`) knows it. Only IDs at medium confidence or above are kept. */
type FunnelAffiliate = {
	id: string;
	site: string;
	/** The tracking platform whose link carried it; absent on the merchant's own landing URL. */
	platform?: FunnelPlatform;
	parameter: string;
	hopIndices: number[];
	confidence: Confidence;
	/** Other businesses of the chain whose links carry the same ID: one passed its affiliate on to the other. */
	matchedAt: string[];
};

/**
 * A business that can terminate the affiliate: the merchant, or the operator
 * of an affiliate network's tracking domain. A party exists only with an
 * affiliate ID it knows, or, for a merchant without its own, the ID the
 * network that delivered the visitor credits (`creditedBy`).
 */
export type FunnelParty = {
	role: "merchant" | "network";
	site: string;
	hostnames: string[];
	platform?: FunnelPlatform;
	platformConfidence?: Confidence;
	/** Strongest first; every one at medium confidence or above. */
	affiliateIds: string[];
	creditedBy?: { site: string; platform?: FunnelPlatform; platformConfidence?: Confidence; id: string };
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
/** Shorter IDs (`a=1`, `pid=12`) coincide across unrelated sites too often to link them. */
const MIN_MATCHED_ID_LENGTH = 4;
const UNINFORMATIVE_VALUE = /^(?:true|false|null|undefined|none|unknown|default)$/i;

type Located = { hopIndex: number; url: URL };

/**
 * Tracking links a redirect carries without the visit requesting them: a
 * wrapper's encoded target (`/redirect?target=BASE64…`), a deep link, or a
 * `Location` the visit never followed.
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
 * A network tracker that can name its affiliate: a link the visit requested
 * (a URL only carried in a parameter is evidence, never a party), of a
 * recognised network platform, at medium confidence or above.
 */
function isNetworkTracker(tracker: TrackingHop): boolean {
	return !tracker.carriedBy && tracker.role === "network" && tracker.confidence !== "low";
}

/**
 * Reads a recorded redirect chain as an affiliate funnel: which hops are
 * tracking links of which platform and what they carry, which only wrap the
 * next URL, which pages lured the visitor, which paid offer it ended on, and
 * the affiliate IDs as each business in the chain knows them. Pure: it reads
 * URLs only and fetches nothing. Built for precision: the parties it names
 * are mailed automatically, so a guess never becomes one.
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
		// A shown page's links (a checkout's return_url) are not where the visitor was sent.
		if (isShown) continue;
		const wrapped = wrappedUrls(url);
		const location = hop.redirectTo ? [{ parameter: "Location", encoding: "location" as const, url: hop.redirectTo }] : [];
		trackingHops.push(...carriedTrackers(hop.index, [...wrapped, ...location], requested));
		if (!kinds.has(hop.index) && wrapped[0]) {
			redirectors.push({ hopIndex: hop.index, url: url.toString(), site, parameter: wrapped[0].parameter, encoding: wrapped[0].encoding, target: wrapped[0].url });
			kinds.set(hop.index, "redirector");
		}
	}

	// The merchant is the last page shown, reached through an affiliate network's
	// link, or through any tracker with an affiliate ID landing on it.
	// Only the links between the last page of another site and the merchant's
	// page delivered the visitor to it; a network link before the lure fed the lure.
	const requestedTrackers = trackingHops.filter((tracker) => !tracker.carriedBy);
	const lastPage = hops.findLast(({ hop }) => shown.has(hop.index) && kinds.get(hop.index) !== "tracker");
	const lastLure = lastPage && hops.findLast(({ hop, site }) => hop.index < lastPage.hop.index && shown.has(hop.index) && kinds.get(hop.index) !== "tracker" && site !== lastPage.site);
	const windowStart = lastLure?.hop.index ?? -1;
	const delivering = lastPage ? requestedTrackers.filter((tracker) => tracker.hopIndex > windowStart && tracker.hopIndex < lastPage.hop.index) : [];
	let merchant: FunnelMerchant | undefined;
	if (lastPage && delivering.length && !isPlatformHost(lastPage.url.hostname)) {
		const lastTracker = delivering.at(-1)!;
		const landing = hops.filter(({ hop, site }) => hop.index > lastTracker.hopIndex && hop.index <= lastPage.hop.index && site === lastPage.site);
		const identifiers = landing
			.flatMap(({ url }) => landingIdentifiers(url))
			.filter((identifier, index, all) => all.findIndex((other) => other.parameter === identifier.parameter && other.value === identifier.value) === index);
		const landingAffiliate = identifiers.some((identifier) => identifier.kind === "affiliate" && identifier.confidence !== "low");
		if (delivering.some(isNetworkTracker) || landingAffiliate) {
			const first = landing[0] ?? lastPage;
			merchant = { hopIndex: first.hop.index, url: first.url.toString(), hostname: first.url.hostname, site: lastPage.site, identifiers };
			for (const { hop } of landing) kinds.set(hop.index, "merchant");
			kinds.set(lastPage.hop.index, "merchant");
		}
	}
	const lurePageHops = hops
		.filter(({ hop, site }) => shown.has(hop.index) && kinds.get(hop.index) !== "tracker" && kinds.get(hop.index) !== "merchant" && (!merchant || (hop.index < merchant.hopIndex && site !== merchant.site)))
		.map(({ hop }) => hop.index);
	for (const index of lurePageHops) kinds.set(index, "lure");

	const affiliateMap = new Map<string, FunnelAffiliate>();
	for (const tracker of trackingHops.filter(isNetworkTracker)) {
		for (const identifier of tracker.identifiers) {
			// A generic parameter on a platform's link (`pid`, `aff`) keeps its own, weaker confidence.
			const confidence = identifier.confidence ? weakerConfidence(identifier.confidence, tracker.confidence) : tracker.confidence;
			if (identifier.kind !== "affiliate" || confidence === "low") continue;
			mergeAffiliate(affiliateMap, { id: identifier.value, site: tracker.site, platform: tracker.platform, parameter: identifier.parameter, hopIndices: [tracker.hopIndex], confidence });
		}
	}
	for (const identifier of merchant?.identifiers ?? []) {
		// A bare `pid` or `aff` names a product or a page as often as an affiliate.
		if (identifier.kind !== "affiliate" || identifier.confidence === "low") continue;
		mergeAffiliate(affiliateMap, { id: identifier.value, site: merchant!.site, parameter: identifier.parameter, hopIndices: [merchant!.hopIndex], confidence: identifier.confidence });
	}
	const affiliates = [...affiliateMap.values()].sort((a, b) => a.hopIndices[0]! - b.hopIndices[0]!);
	for (const affiliate of affiliates) {
		if (affiliate.id.length < MIN_MATCHED_ID_LENGTH) continue;
		affiliate.matchedAt = [...new Set(affiliates.filter((other) => other.id === affiliate.id && other.site !== affiliate.site).map((other) => other.site))];
		// The same ID on the network's link and on the next business proves both read it as the affiliate.
		if (affiliate.matchedAt.length) affiliate.confidence = "high";
	}

	const parties: FunnelParty[] = [];
	const idsAt = (site: string) => affiliates
		.filter((affiliate) => affiliate.site === site)
		.sort((a, b) => confidenceRank(a.confidence) - confidenceRank(b.confidence) || a.hopIndices[0]! - b.hopIndices[0]!)
		.map((affiliate) => affiliate.id);
	const networkTrackers = trackingHops.filter(isNetworkTracker);
	for (const site of new Set(networkTrackers.map((tracker) => tracker.site))) {
		const atSite = networkTrackers.filter((tracker) => tracker.site === site);
		const ids = idsAt(site);
		if (site === merchant?.site || !ids.length || atSite.some((tracker) => isPlatformHost(tracker.hostname))) continue;
		const strongest = [...atSite].sort((a, b) => confidenceRank(a.confidence) - confidenceRank(b.confidence))[0]!;
		parties.push({
			role: "network",
			site,
			hostnames: [...new Set(atSite.map((tracker) => tracker.hostname))],
			platform: strongest.platform,
			platformConfidence: strongest.confidence,
			affiliateIds: ids,
			hopIndices: [...new Set(atSite.map((tracker) => tracker.hopIndex))],
		});
	}
	if (merchant) {
		const ownTracker = networkTrackers.find((tracker) => tracker.site === merchant.site);
		const own = idsAt(merchant.site);
		const deliveredBy = parties.findLast((party) => delivering.some((tracker) => isNetworkTracker(tracker) && tracker.site === party.site));
		if (own.length || deliveredBy) {
			parties.unshift({
				role: "merchant",
				site: merchant.site,
				hostnames: [...new Set(hops.filter(({ site }) => site === merchant.site).map(({ url }) => url.hostname))],
				...(ownTracker ? { platform: ownTracker.platform, platformConfidence: ownTracker.confidence } : {}),
				affiliateIds: own,
				...(!own.length && deliveredBy
					? { creditedBy: { site: deliveredBy.site, ...(deliveredBy.platform ? { platform: deliveredBy.platform, platformConfidence: deliveredBy.platformConfidence } : {}), id: deliveredBy.affiliateIds[0]! } }
					: {}),
				hopIndices: hops.filter(({ site }) => site === merchant.site).map(({ hop }) => hop.index),
			});
		}
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

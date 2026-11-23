/**
 * Recognises affiliate tracking platforms by the URLs they hand out, and
 * reads the identifiers those URLs carry, under the names the platform and
 * its customers use. Formats are from the platforms' own documentation where
 * it exists (cited per recogniser) and otherwise from links observed in the
 * wild; an identifier whose meaning no documentation states is reported by
 * its parameter name only, never interpreted.
 */

export type FunnelPlatform = "cake" | "everflow" | "tune" | "voluum" | "binom" | "keitaro" | "redtrack";

/**
 * Who runs a tracking hop: an affiliate network's (or an advertiser's own
 * affiliate program's) tracker that pays the affiliate, or a tracker the
 * affiliate (media buyer) runs for themself to route their own traffic.
 */
type TrackerRole = "network" | "affiliate_tracker";

type IdentifierKind = "affiliate" | "offer" | "creative" | "campaign" | "sub" | "click" | "transaction" | "lander_token" | "other";

export type Confidence = "high" | "medium" | "low";

/**
 * One value a tracking URL carries, under the parameter (or path position)
 * that carried it. `confidence` is set on a generic parameter (`pid`,
 * `aff`, `sub1`), which names what it says less surely than the link's own
 * format; absent, the identifier is as sure as the link.
 */
export type FunnelIdentifier = { kind: IdentifierKind; parameter: string; value: string; confidence?: Confidence };

export type TrackerMatch = {
	platform: FunnelPlatform;
	role: TrackerRole;
	confidence: Confidence;
	/** What in the URL identified the platform, for the report. */
	signals: string[];
	identifiers: FunnelIdentifier[];
};

export const PLATFORM_NAMES: Readonly<Record<FunnelPlatform, string>> = {
	cake: "CAKE",
	everflow: "Everflow",
	tune: "TUNE (HasOffers)",
	voluum: "Voluum",
	binom: "Binom",
	keitaro: "Keitaro",
	redtrack: "RedTrack",
};

/** The platform's name, for a stored platform key; undefined for anything else. */
export function platformName(platform: string | undefined): string | undefined {
	return platform && Object.hasOwn(PLATFORM_NAMES, platform) ? PLATFORM_NAMES[platform as FunnelPlatform] : undefined;
}

/**
 * How a report names the platform of a tracking link: as a fact only when
 * the link's format leaves no doubt; otherwise as the format it has.
 */
export function platformLabel(platform: string | undefined, confidence: Confidence | undefined): string | undefined {
	const name = platformName(platform);
	if (!name) return undefined;
	return confidence === "high" ? name : `a link in ${name}'s format`;
}

const CONFIDENCE_ORDER: Readonly<Record<Confidence, number>> = { high: 0, medium: 1, low: 2 };

export function strongerConfidence(a: Confidence, b: Confidence): Confidence {
	return CONFIDENCE_ORDER[a] <= CONFIDENCE_ORDER[b] ? a : b;
}

export function weakerConfidence(a: Confidence, b: Confidence): Confidence {
	return CONFIDENCE_ORDER[a] >= CONFIDENCE_ORDER[b] ? a : b;
}

export function confidenceRank(confidence: Confidence): number {
	return CONFIDENCE_ORDER[confidence];
}

/** A URL's query parameters by lower-cased name, first value of each. */
type Query = ReadonlyMap<string, string>;

function queryOf(url: URL): Query {
	const query = new Map<string, string>();
	for (const [name, value] of url.searchParams) {
		const key = name.toLowerCase();
		if (!query.has(key)) query.set(key, value);
	}
	return query;
}

/**
 * A value worth naming: present, bounded, and not a macro the tracker left
 * unexpanded (`#leadid#`, `{clickid}`, `[sub1]`).
 */
export function identifierValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	if (/^#[^#]*#$|^\{[^}]*\}$|^\[[^\]]*\]$|^\{\{.*\}\}$/.test(trimmed)) return undefined;
	return trimmed;
}

function identifiersFor(query: Query, names: ReadonlyArray<readonly [string, IdentifierKind]>): FunnelIdentifier[] {
	return names.flatMap(([parameter, kind]) => {
		const value = identifierValue(query.get(parameter));
		return value ? [{ kind, parameter, value }] : [];
	});
}

const SUB_PARAMETERS = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => [`${prefix}${index + 1}`, "sub"] as const);

/**
 * Parameter names affiliate links commonly use outside any one platform's
 * format (an advertiser's landing page `affid=`, Post Affiliate Pro's
 * `a_aid`). A bare `aff` or `pid` names many other things too.
 */
const GENERIC_PARAMETERS: ReadonlyArray<readonly [RegExp, IdentifierKind, Confidence]> = [
	[/^(?:affid|aff_id|affiliate_id|affiliateid|affiliate|a_aid|publisher_id|publisherid|pub_id|pubid|partner_id|partnerid)$/, "affiliate", "medium"],
	[/^(?:aff|pid)$/, "affiliate", "low"],
	[/^(?:offer_id|offerid|oid)$/, "offer", "medium"],
	[/^(?:transaction_id|_ef_transaction_id|txn_id)$/, "transaction", "medium"],
	[/^(?:clickid|click_id|irclickid|aff_click_id)$/, "click", "medium"],
	[/^(?:sub\d{1,2}|subid\d{0,2}|sub_id\d{0,2}|aff_sub\d?|s[1-5]|source)$/, "sub", "low"],
];

/** The identifiers of the commonly used parameter names, with how surely each names what it says. */
function genericIdentifiers(url: URL, skip: ReadonlySet<string> = new Set()): Array<FunnelIdentifier & { confidence: Confidence }> {
	const found: Array<FunnelIdentifier & { confidence: Confidence }> = [];
	for (const [parameter, raw] of queryOf(url)) {
		if (skip.has(parameter)) continue;
		const rule = GENERIC_PARAMETERS.find(([pattern]) => pattern.test(parameter));
		const value = identifierValue(raw);
		if (rule && value) found.push({ kind: rule[1], parameter, value, confidence: rule[2] });
	}
	return found;
}

function match(params: Omit<TrackerMatch, "identifiers"> & { url: URL; identifiers: FunnelIdentifier[] }): TrackerMatch {
	const consumed = new Set(params.identifiers.map((identifier) => identifier.parameter));
	const rest = genericIdentifiers(params.url, consumed);
	return {
		platform: params.platform,
		role: params.role,
		confidence: params.confidence,
		signals: params.signals,
		identifiers: [...params.identifiers, ...rest],
	};
}

const NUMERIC_ID = /^\d{1,10}$/;

function isRootPath(url: URL): boolean {
	return url.pathname === "/" || url.pathname === "";
}

/**
 * CAKE: `https://<tracking domain>/?a=<affiliate id>&c=<creative id>&s1=…&s5=`
 * ("Understanding the CAKE Tracking Link", support.getcake.com: `a` is the
 * affiliate ID, `c` the creative, `s1`–`s5` the affiliate's sub IDs). A CAKE
 * install answers a first click with a redirect to the same link plus
 * `ch-redir=1&ckmxid=…` (and `ckmguid`), seen in sandbox captures of CAKE
 * domains; those markers make the platform certain. Without them the link is
 * only a low-confidence guess: evidence, never a party.
 */
function cake(url: URL, query: Query): TrackerMatch | undefined {
	const affiliate = query.get("a");
	if (!affiliate || !NUMERIC_ID.test(affiliate)) return undefined;
	const creative = query.get("c");
	const markers = ["ckmxid", "ckmguid", "ch-redir"].filter((name) => query.has(name));
	if (!markers.length && !(creative && NUMERIC_ID.test(creative) && isRootPath(url))) return undefined;
	return match({
		url,
		platform: "cake",
		role: "network",
		// `?a=<n>&c=<n>` on a root URL alone is too common a shape to name a network.
		confidence: markers.length ? "high" : "low",
		signals: [
			`CAKE affiliate link parameters a=${affiliate}${creative ? `&c=${creative}` : ""}`,
			...(markers.length ? [`CAKE click markers ${markers.join(", ")}`] : []),
		],
		identifiers: identifiersFor(query, [["a", "affiliate"], ["c", "creative"], ...SUB_PARAMETERS("s", 5), ["ckmxid", "click"], ["ckmguid", "click"]]),
	});
}

/** An Everflow-encoded ID: 4–8 upper-case letters and digits, both present (`28KL6`, `2CTPL`, `6RNXHT`). */
const EVERFLOW_ID = /^(?=[0-9A-Z]*\d)(?=[0-9A-Z]*[A-Z])[0-9A-Z]{4,8}$/;
/** Everflow's sub IDs, its transaction parameter, and the `__`-parameters its redirects between offers add. */
const EVERFLOW_PARAMETERS = ["sub1", "sub2", "sub3", "sub4", "sub5", "source_id", "_ef_transaction_id", "__ptid", "__po", "__rpt", "__rpa", "__rc"];

/**
 * Everflow: `https://<tracking domain>/<affiliate>/<offer>/?sub1=…` with both
 * IDs encoded. Everflow's API documentation ("Encoding / Decoding",
 * developers-legacy.everflow.io/docs/network/encoding) states that in
 * `/28KL6/2CTPL/` "28KL6 identifies partner ID 1 whereas 2CTPL identifies
 * offer ID 1"; the network decodes them with its API. Smart links are
 * `/cmp/<id>/<id>/`, whose segment order no documentation states. When a
 * network sends a click on to another offer it appends `__po`, `__ptid` and
 * related parameters (observed; undocumented), reported verbatim. Two
 * upper-case path segments alone (a link shortener's code looks the same)
 * are only a low-confidence guess, never enough to name a network.
 */
function everflow(url: URL, query: Query): TrackerMatch | undefined {
	const segments = url.pathname.split("/").filter(Boolean);
	const smartLink = segments.length === 3 && segments[0] === "cmp" && EVERFLOW_ID.test(segments[1]!) && EVERFLOW_ID.test(segments[2]!);
	const offerLink = segments.length === 2 && EVERFLOW_ID.test(segments[0]!) && EVERFLOW_ID.test(segments[1]!);
	if (!smartLink && !offerLink) return undefined;
	const markers = EVERFLOW_PARAMETERS.filter((name) => query.has(name));
	const pathIdentifiers: FunnelIdentifier[] = smartLink
		? [{ kind: "campaign", parameter: "path", value: `${segments[1]}/${segments[2]}` }]
		: [{ kind: "affiliate", parameter: "path", value: segments[0]! }, { kind: "offer", parameter: "path", value: segments[1]! }];
	return match({
		url,
		platform: "everflow",
		role: "network",
		confidence: markers.length ? "high" : "low",
		signals: [
			smartLink ? `Everflow smart link path /cmp/${segments[1]}/${segments[2]}/` : `Everflow tracking link path /${segments[0]}/${segments[1]}/ (affiliate/offer)`,
			...(markers.length ? [`Everflow parameters ${markers.join(", ")}`] : []),
		],
		identifiers: [
			...pathIdentifiers,
			...identifiersFor(query, [...SUB_PARAMETERS("sub", 5), ["source_id", "sub"], ["_ef_transaction_id", "transaction"], ["__ptid", "other"], ["__po", "other"]]),
		],
	});
}

/**
 * TUNE (formerly HasOffers): `https://<network domain>/aff_c?offer_id=…&aff_id=…`
 * with `aff_sub`…`aff_sub5`, `source` and an optional `url=` deep link
 * ("Generating Tracking Links" and "Customizing a Partner Tracking Link",
 * support.tune.com). `aff_id` is the partner credited for the click.
 */
function tune(url: URL, query: Query): TrackerMatch | undefined {
	if (!/^\/aff_c\/?$/i.test(url.pathname) || !(query.has("offer_id") || query.has("aff_id"))) return undefined;
	return match({
		url,
		platform: "tune",
		role: "network",
		confidence: query.has("offer_id") && query.has("aff_id") ? "high" : "medium",
		signals: ["TUNE click path /aff_c with offer_id/aff_id"],
		identifiers: identifiersFor(query, [
			["aff_id", "affiliate"],
			["offer_id", "offer"],
			["aff_sub", "sub"],
			...SUB_PARAMETERS("aff_sub", 5).slice(1),
			["source", "sub"],
			["transaction_id", "transaction"],
			["aff_click_id", "click"],
		]),
	});
}

/**
 * Binom (self-hosted): campaign links and a lander's offer link are
 * `click.php?key=<campaign>` and `click.php?lp=1`, with `uclick` carrying the
 * click ("Click API", "Adding a landing page", docs.binom.org).
 */
function binom(url: URL, query: Query): TrackerMatch | undefined {
	if (!/\/click\.php$/i.test(url.pathname) || !(query.has("key") || query.has("lp"))) return undefined;
	return match({
		url,
		platform: "binom",
		role: "affiliate_tracker",
		confidence: "high",
		signals: [`Binom click.php with ${query.has("key") ? "key" : "lp"}`],
		identifiers: identifiersFor(query, [["key", "campaign"], ["uclick", "click"]]),
	});
}

/**
 * Keitaro (self-hosted): a lander's offer link is `/?_lp=1&_token=…`, the
 * click is `subid`/`_subid` ("Offer URL", "Click API", docs.keitaro.io).
 * Campaign links are a bare alias and cannot be told apart from any path.
 */
function keitaro(url: URL, query: Query): TrackerMatch | undefined {
	const offerLink = query.has("_lp") && (query.has("_token") || query.has("token"));
	if (!offerLink && !(query.has("_subid") && query.has("_token"))) return undefined;
	return match({
		url,
		platform: "keitaro",
		role: "affiliate_tracker",
		confidence: "high",
		signals: [offerLink ? "Keitaro offer link parameters _lp and _token" : "Keitaro parameters _subid and _token"],
		identifiers: identifiersFor(query, [["_subid", "click"], ["subid", "click"], ["offer_id", "offer"]]),
	});
}

/**
 * RedTrack: its click ID travels as `rtkcid` and its campaign as `rtkcmpid`
 * (RedTrack integration guides and AI glossary, help.redtrack.io).
 */
function redtrack(url: URL, query: Query): TrackerMatch | undefined {
	if (!query.has("rtkcid") && !query.has("rtkcmpid")) return undefined;
	return match({
		url,
		platform: "redtrack",
		role: "affiliate_tracker",
		confidence: "high",
		signals: ["RedTrack parameters rtkcid/rtkcmpid"],
		identifiers: identifiersFor(query, [["rtkcid", "click"], ["rtkcmpid", "campaign"], ["cmpid", "campaign"]]),
	});
}

const UUID_PATH = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/**
 * Voluum (hosted): a campaign URL is `https://<tracking domain>/<campaign UUID>?…`;
 * a lander's offer links are `/click` and, for several offers, `/click/1`,
 * `/click/2` ("Adding Click URLs to a Lander", doc.voluum.com), which carry
 * the visit as `cep` ("cep is missing", Voluum error log). A lander Voluum
 * protects gets an `lptoken` (Voluum staff, affiliatefix.com). The UUID path
 * alone is only likely Voluum.
 */
function voluum(url: URL, query: Query): TrackerMatch | undefined {
	if (/^\/click(?:\/\d{1,2})?\/?$/i.test(url.pathname) && query.has("cep")) {
		return match({ url, platform: "voluum", role: "affiliate_tracker", confidence: "high", signals: ["Voluum lander click URL /click with cep"], identifiers: [] });
	}
	const campaign = UUID_PATH.exec(url.pathname)?.[1];
	if (!campaign) return undefined;
	return match({
		url,
		platform: "voluum",
		role: "affiliate_tracker",
		confidence: "medium",
		signals: ["campaign UUID path, Voluum's campaign URL format"],
		identifiers: [{ kind: "campaign", parameter: "path", value: campaign.toLowerCase() }],
	});
}

const RECOGNISERS = [cake, everflow, tune, binom, keitaro, redtrack, voluum] as const;

/** The tracking platform whose link format the URL has, with what it carries; undefined for any other URL. */
export function recogniseTracker(url: URL): TrackerMatch | undefined {
	const query = queryOf(url);
	for (const recognise of RECOGNISERS) {
		const found = recognise(url, query);
		if (found) return found;
	}
	return undefined;
}

/**
 * The identifiers on a page's own URL: the affiliate parameters an
 * advertiser's landing page receives (`affid=15065&sub1=…`), and the token a
 * Voluum-protected lander gets.
 */
export function landingIdentifiers(url: URL): Array<FunnelIdentifier & { confidence: Confidence }> {
	const token = identifierValue(url.searchParams.get("lptoken") ?? undefined);
	return [
		...genericIdentifiers(url),
		...(token ? [{ kind: "lander_token" as const, parameter: "lptoken", value: token, confidence: "medium" as const }] : []),
	];
}

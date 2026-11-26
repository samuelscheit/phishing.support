import { andList } from "../util/text";
import type { ClipboardWrite } from "../browser/clipboard";
import type { DeceptiveFunnelVerdict } from "../abuse/funnel/classification";
import type { FunnelExtraction } from "../abuse/funnel/extract";

export type WebsiteNavigationHop = {
	index: number;
	url: string;
	hostname: string;
	status: number | null;
	redirectTo?: string;
	contentType?: string;
	/**
	 * Set on a page the visiting agent moved on from, as a victim would:
	 * `redirectTo` is the page that then showed, and `submitted` names the
	 * synthetic values the page sent off while it was shown (its form, or its
	 * script). The page was captured as an earlier step of the case.
	 */
	visitorStep?: { submitted: CanaryField[] };
	/** Set when the capture opened the page again; `redirectTo` is the page it was shown then. */
	revisit?: WebsiteRevisit;
	/**
	 * Set on a document answer whose raw body, as the network delivered it, is
	 * kept as `chain-hop-<index>.html`: also an interstitial that sent the
	 * visitor on by script before anything was shown.
	 */
	bodyCaptured?: boolean;
	/** When the answer arrived (ISO 8601), as the browser's network layer held it; a redirect's too. */
	receivedAt?: string;
	contentCaptured: boolean;
};

/** Why and how the capture opened a page of the visit again. */
export type WebsiteRevisit =
	/** The page turned desktop visitors away to a phone (a QR code, a link to copy, "not available on desktop"): opened again as that phone. */
	| { reason: "phone"; device: WebsiteMobileDevice }
	/** A CAPTCHA or browser check still blocked the visit after waiting, as it does for the network the visit came from: opened again from `route`. */
	| { reason: "challenge"; route: string }
	/** The site the flow led to answered with nothing and sent the visit back, as a traffic filter does for a visitor it turns away: the whole flow is walked again from `route`. */
	| { reason: "destination_cloaked"; route: string; site: string };

/**
 * The case's chain judged as one affiliate funnel: the tracking links,
 * affiliate IDs and businesses it passed (`extraction`), whether its lure
 * misrepresented the offer it led to (`verdict`), and the businesses a
 * deceptive funnel's report skipped, with why.
 */
export type WebsiteFunnel = {
	extraction: FunnelExtraction;
	verdict: DeceptiveFunnelVerdict;
	skipped?: Array<{ site: string; role: "merchant" | "network"; reason: string }>;
};

/**
 * One walk of the submitted link and the chain it took: a link that rotates
 * offers per click (an affiliate network's smart link) sends each visit down
 * another route, each with its own sites, pages and verdicts. The case's first
 * walk is route 0; a sampled visit that reached a destination no route showed
 * yet is the next.
 */
export type WebsiteRoute = {
	/**
	 * The route's chain, response by response, across every site it passed:
	 * redirects, pages that sent the visitor on by script, pages the visit moved
	 * on from, and the last page shown (`contentCaptured`).
	 */
	hops: WebsiteNavigationHop[];
	/** The hop of the page the route's verdict rests on: its first reportable page, else the last page shown. */
	analyzedHopIndex?: number;
	/** One per hop: the verdict of the hop's site, which every hop of that site shares. */
	siteAssessments?: WebsiteSiteAssessment[];
	/** The route judged as an affiliate funnel; set when it passed an affiliate tracking link. */
	funnel?: WebsiteFunnel;
	/** The walk through the route's sites: what the agent did and where the synthetic values went. */
	visit?: WebsiteVisitRecord;
	/** How the walk opened the link: the browser it presented and the network it came from. */
	visitor?: WebsiteRouteVisitor;
};

/** The browser and network a walk of the submitted link presented. */
export type WebsiteRouteVisitor = { browser: string; network?: string };

/**
 * The visits a case made to sample a rotating link's other offers, after its
 * first walk passed a tracking link, and why it made no more.
 */
export type WebsiteRotation = {
	visits: WebsiteRotationVisit[];
	/** Why sampling stopped: the visits were used up, two in a row showed nothing new, its time ran out, or the network failed. */
	ended: string;
};

/**
 * One sampled visit: the route it showed for the first time (`route`), a route
 * it showed again (`repeatOf`, with the hops that reached it), or its failure.
 */
export type WebsiteRotationVisit = {
	startedAt: string;
	visitor: WebsiteRouteVisitor;
} & ({ route: number } | { repeatOf: number; hops: WebsiteNavigationHop[] } | { error: string });

export type WebsiteCloakedDestination = {
	host: string;
	site: string;
	/** The networks the flow was walked through, each answered empty. */
	answered: string[];
	/** Networks that could not be tried, with why. */
	notTried: Array<{ network: string; reason: string }>;
};

/** How a person reads a revisit: what made the capture open the page again, and how it did. */
export function revisitWording(revisit: WebsiteRevisit): { cause: string; opened: string } {
	switch (revisit.reason) {
		case "phone":
			return { cause: "it turns desktop visitors away to a phone", opened: `as ${WEBSITE_DEVICE_LABEL[revisit.device]}` };
		case "challenge":
			return { cause: "a CAPTCHA or browser check blocked our visit from the network it first came from", opened: `from the ${revisit.route}` };
		case "destination_cloaked":
			return { cause: `its flow led to ${revisit.site}, which answered with nothing and sent the visit back`, opened: `from the ${revisit.route}` };
	}
}

/** The synthetic values a visit enters, by name. */
export type CanaryField = "email" | "password" | "phone" | "cardNumber" | "oneTimeCode";

/** How a report and a person name a synthetic value. */
export const CANARY_FIELD_LABEL: Record<CanaryField, string> = {
	email: "email address",
	password: "password",
	phone: "phone number",
	cardNumber: "card number",
	oneTimeCode: "one-time code",
};

/** The labels of some synthetic values, as a sentence part: "email address and password". */
export function canaryFieldList(fields: readonly CanaryField[]): string {
	return andList(fields.map((field) => CANARY_FIELD_LABEL[field]));
}

/** One request through which a page sent synthetic values off while it was shown. */
export type VisitDataSent = {
	url: string;
	method: string;
	fields: CanaryField[];
	/** Sent to the page's own site, rather than to a bot, a webhook, or another host. */
	sameSite: boolean;
};

/** The visit as the case keeps it: what the agent did, and every request that carried synthetic values. */
export type WebsiteVisitRecord = {
	/** `completed`: the agent finished; `failed`: it failed or could not start; `timed_out`: the visit's budget ended it. */
	outcome: "completed" | "failed" | "timed_out";
	failure?: string;
	report?: { asksForPhone: boolean; blockedByChallenge: boolean; stoppedReason: string };
	actions: Array<{ kind: string; text: string }>;
	dataSent: VisitDataSent[];
	downloadFailures: Array<{ url: string; reason: string }>;
	/** What the site's pages put on the clipboard, from its capture on: what a visitor pastes. Absent when nothing was copied. */
	clipboardWrites?: ClipboardWrite[];
};

/** Whether the visit moved on from this hop to a later page: the agent went on, or the page was opened again. */
export function isFlowStepHop(hop: WebsiteNavigationHop): boolean {
	return Boolean(hop.visitorStep || hop.revisit);
}

/** The browser a capture presents: a Windows desktop, or a phone a mobile-only kit asks for. */
export type WebsiteDevice = "desktop" | WebsiteMobileDevice;
type WebsiteMobileDevice = "iphone";

/** How a person reads the device a page was opened as. */
export const WEBSITE_DEVICE_LABEL: Record<WebsiteDevice, string> = {
	desktop: "Google Chrome on Windows",
	iphone: "Safari on an iPhone (iOS 18.6.2)",
};

/** A response a hidden frame received while the capture watched it. */
export type WebsiteFrameResource = {
	url: string;
	/** Chromium's resource type: `document`, `script`, `fetch`, `xhr`, … */
	type: string;
	/**
	 * What asked for it: the frame's markup (a `<script src>` or `<link>` the
	 * parser met, such as the beacon Cloudflare injects into every page it
	 * proxies) or the frame's code at run time (`fetch`, an appended script),
	 * which is how a loader pulls its next stage.
	 */
	loadedBy: WebsiteResourceInitiator;
	status: number;
	size: number;
	sha256: string;
};

export type WebsiteResourceInitiator = "markup" | "script" | "other";

/** A request other than GET a hidden frame sent: where a loader posts what it took. */
export type WebsiteFrameRequest = {
	url: string;
	method: string;
	/** The start of its body, as sent. */
	body?: string;
};

/** Data a loader's code sends off the device, and the endpoint it sends it to. */
export type WebsiteDataUpload = {
	url: string;
	/** What the code around the upload names, e.g. `keychain`, `wallet`. */
	data: string[];
	/** Whether the capture saw the request go out, not just the code that sends it. */
	observed: boolean;
};

/**
 * What a hidden frame's code was found to do, from its source and the
 * scripts it loaded. These are hints for the classifier and facts for the
 * report; the classifier's quote from the source is what decides.
 */
export type WebsiteExploitSignals = {
	/** Platform tokens the code reads from the visitor's User-Agent to choose what to load, e.g. `iPhone OS`. */
	platformGate: string[];
	/** The code fetches code and runs it (`eval`, `new Function`). */
	runsFetchedCode: boolean;
	/** Files of the next stages: what the frame loaded, and the code files its source names. */
	stageUrls: string[];
	dataUploads: WebsiteDataUpload[];
};

/**
 * A frame on the captured page that no visitor can see: zero-sized,
 * off-screen, or hidden by style, or inside such a frame. Exploit kits run
 * there; its source is evidence that the MHTML (which drops scripts) and the
 * page text (which drops what no one sees) both lose.
 */
export type WebsiteHiddenFrame = {
	/** Reference assigned in frame order; the classifier cites it. */
	ref: string;
	url: string;
	/** Why no visitor sees it, e.g. `0×0 size`, `positioned off-screen`. */
	hiddenBy: string;
	/** Hash and size of the frame's document as received. */
	sha256: string;
	size: number;
	/** The document's source, as received (bounded). */
	source: string;
	resources: WebsiteFrameResource[];
	sentRequests: WebsiteFrameRequest[];
	signals: WebsiteExploitSignals;
	/** The User-Agent the frame was served to; its loader may serve its stages only to it. */
	userAgent: string;
};

/**
 * How a capture handled a page whose own script sends visitors to another site.
 * `scripted`: the residential exit was sent there, which the archive holds; it
 * is either where the page leads victims or a decoy for every visitor, and the
 * verdict on the chain tells them apart: nothing reportable fails the case as
 * suspected cloaking. `unresolved`: the residential exit was unavailable and
 * Tor or the server IP was sent there, possibly a decoy for scanners only.
 */
export type WebsiteCloaking = { outcome: "scripted" | "unresolved"; detail: string };

/** What a downloaded file is, from its own bytes rather than its name or served type. */
export type DownloadFormat =
	| "browser_extension"
	| "zip_archive"
	| "android_app"
	| "java_archive"
	| "windows_executable"
	| "windows_installer"
	| "macos_disk_image"
	| "macos_executable"
	| "linux_executable"
	| "disk_image"
	| "rar_archive"
	| "7z_archive"
	| "gzip_archive"
	| "pdf"
	| "script"
	| "html"
	| "other";

/** A line of the file's code that reads, sends, or runs something, with the lines around it. */
export type DownloadCodeExcerpt = {
	/** The file inside the download (its path in an archive), or the download's own name. */
	file: string;
	/** 1-based line of the match; minified code is cut around the match instead of by lines. */
	line: number;
	text: string;
	/** What the matched code does: `reads_cookies`, `reads_credentials`, `sends_data`, `runs_code`. */
	signals: DownloadCodeSignal[];
};

export type DownloadCodeSignal = "reads_cookies" | "reads_credentials" | "sends_data" | "runs_code";

/**
 * A file inspected without ever being run: what it is, what it holds, and the
 * code in it that touches the visitor's data. Signals are hints for the
 * classifier; its quote from an excerpt is what decides.
 */
export type DownloadInspection = {
	format: DownloadFormat;
	/** Files inside an archive (bounded), with the total count. */
	entries?: Array<{ path: string; size: number }>;
	entryCount?: number;
	/** A browser extension's manifest: what it may read and where it runs. */
	browserExtension?: {
		name: string;
		version?: string;
		permissions: string[];
		hostPermissions: string[];
		contentScriptMatches: string[];
	};
	/** A Windows executable's Authenticode certificate table, read structurally. */
	signature?: "not_signed" | "signed_binary" | "unknown";
	/** Which files' code does what. */
	signals: Partial<Record<DownloadCodeSignal, string[]>>;
	/** Remote addresses named in the code, most frequent first. */
	endpoints: string[];
	excerpts: DownloadCodeExcerpt[];
	/** What a malware scanner already says about the file's hash. */
	scannerVerdicts?: Array<{ provider: string; verdict: "malicious" | "suspicious" | "benign" }>;
};

/** The file a page offers, as the capture received it by taking the page's own download step. */
export type WebsiteOfferedDownload = {
	/** The page the visit was on when the file downloaded. */
	pageUrl: string;
	url: string;
	fileName: string;
	contentType?: string;
	sizeBytes: number;
	sha256: string;
	/** The browser identity the file was served to; a host may refuse any other. */
	userAgent: string;
	inspection: DownloadInspection;
};

/**
 * A provider's own warning page that stood before the site, which the capture
 * dismissed as a visitor would: Cloudflare's "Suspected Phishing" interstitial.
 */
export type WebsiteProviderWarning = { provider: string; warning: string };

/**
 * A script or stylesheet, from any host, as the browser received it during capture.
 * Its hash is the HTTP response-body hash urlscan.io indexes, so it can find
 * other sites serving the identical kit file.
 */
export type WebsiteKitResource = {
	url: string;
	mimeType: string;
	size: number;
	sha256: string;
};

/**
 * `phishing` impersonates a trusted brand to take credentials or payment;
 * `malware` gets the visitor to download, install, or run something, whether
 * or not it borrows a real brand, or attacks the visitor's device from a
 * frame no one sees (a drive-by exploit). Only these two findings are reported.
 */
export type WebsiteSiteFinding = "phishing" | "malware" | "benign" | "prank_or_troll" | "insufficient_evidence";

/** Each finding as a person reads it. */
export const WEBSITE_FINDING_LABELS: Record<WebsiteSiteFinding, string> = {
	phishing: "Phishing",
	malware: "Malware distribution",
	benign: "Not phishing or malware",
	prank_or_troll: "Prank / troll — not phishing",
	insufficient_evidence: "Insufficient evidence",
};

/** What a confirmed phishing page takes from its visitor. */
export type WebsitePhishingBasis = "credential_theft" | "payment_fraud";

/** A captured control through which a visitor can enter data, with or without a surrounding form. */
export type WebsiteDataEntryField = {
	/** Reference assigned in document order; the classifier cites it. */
	ref: string;
	/** Element and input type, for example `input[type=text]` or `textarea`. */
	control: string;
	id?: string;
	name?: string;
	autocomplete?: string;
	label?: string;
	placeholder?: string;
};

/** The control's most human-readable descriptor. */
export function describeDataEntryField(field: WebsiteDataEntryField): string {
	return field.label ?? field.placeholder ?? field.name ?? field.id ?? field.control;
}

export type WebsiteSiteClassification = {
	finding: WebsiteSiteFinding;
	/** Set only for `phishing`. */
	phishingBasis?: WebsitePhishingBasis;
	/** Verbatim excerpt of the captured page text, in the page's own language. */
	evidenceQuote?: string;
	/** Captured data-entry fields through which the page itself collects the data, when it has any. */
	collectionFields?: WebsiteDataEntryField[];
	/**
	 * Set for a drive-by exploit: the hidden frame whose source the quote comes
	 * from, instead of the page text.
	 */
	hiddenFrame?: { ref: string; url: string };
	/** For phishing: the brand the page imitates and that brand's own official site. */
	impersonatedBrand?: { name: string; officialUrl: string };
	/**
	 * Set for malware proven by the file the page offers: the quote comes from
	 * the code of that file, instead of the page text.
	 */
	offeredDownload?: { fileName: string; sha256: string };
	/**
	 * Set for malware proven by what the page put on the visitor's clipboard
	 * (a Copy button handing out a command other than the one shown): the
	 * quote comes from that text or what it decodes to, instead of the page text.
	 */
	clipboardWrite?: { documentUrl: string; sha256: string };
	/** Why the classifier's phishing or malware claim was not corroborated by the captured page. */
	rejectedClaim?: string;
};

/** The verdict of a hop's site: every hop of one site shares it, and a site that showed no page has insufficient evidence. */
export type WebsiteSiteAssessment = WebsiteSiteClassification & {
	hopIndex: number;
	/** The page of the site whose classification is the site's verdict; absent for a site that showed no page. */
	judgedHopIndex?: number;
};

/** The two findings that are reported to providers. */
export type ReportableWebsiteFinding = { finding: "phishing"; phishingBasis: WebsitePhishingBasis } | { finding: "malware" };

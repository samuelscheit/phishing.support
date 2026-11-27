import type { FabricEgress } from "../../browser/fabric";
import type { BrowserIdentity, getBrowser } from "../../browser";
import type { ExfiltrationCanaries } from "../../exfiltration/types";
import type { confirmHostNxdomain } from "../../network/dead_dns";
import type { VisitAgent } from "../../site_visit/agent";
import type { SiteVisitLiveEvent, SiteVisitRecording } from "../../site_visit/visit";
import type { VisitControl } from "../../site_visit/control";
import type { WebsiteCloaking, WebsiteDevice, WebsiteHiddenFrame, WebsiteKitResource, WebsiteNavigationHop, WebsiteProviderWarning } from "../types";
import type { HopBody } from "../visit/tab_recording";

export type WebsiteArchiveResult = {
	/** The submitted URL is retained separately from the captured document URL. */
	requestedUrl: string;
	/** How the capture handled the page's scripted jump to another site. */
	cloaking?: WebsiteCloaking;
	/** Set when the captured page sat behind a fake verification gate that was clicked through. */
	verificationGate?: WebsiteVerificationGate;
	/** Set when a provider's warning page stood before the site and the capture dismissed it. */
	providerWarning?: WebsiteProviderWarning;
	/** URL whose document body, screenshot, and MHTML are captured. */
	url: string;
	hostname: string;
	navigationHops: WebsiteNavigationHop[];
	/** The raw bodies of the document answers among `navigationHops` (`bodyCaptured`), by hop index; live captures only. */
	hopBodies?: HopBody[];
	/** Timestamp embedded in the MHTML capture, or the capture time when it is not available. */
	archivedAt: Date;
	/** The network route the live capture used, for example "Tor exit"; absent for MHTML. */
	route?: string;
	/** The Fabric egress of a live capture; `route` is how it reads. */
	egress?: FabricEgress;
	screenshotPng?: Buffer;
	mhtml: Buffer;
	html: Buffer;
	text: Buffer;
	/** Scripts and stylesheets the live capture received, from any host; MHTML drops scripts and re-serializes CSS. */
	kitResources?: WebsiteKitResource[];
	/** Frames of the captured page no visitor can see, with the code they loaded; MHTML keeps none of it. */
	hiddenFrames?: WebsiteHiddenFrame[];
	/** The browser the live capture presented; absent means the Windows desktop. */
	device?: WebsiteDevice;
	/** The User-Agent the live capture presented; a provider's reviewer needs it to see what the capture saw. */
	userAgent?: string;
	/**
	 * The live page's whole DOM when it was captured, closed dialogs included.
	 * Chrome's MHTML leaves out elements that are not rendered, so a command in
	 * a `hidden` install dialog (macmorrow.app) is only here. Live captures only.
	 */
	documentHtml?: string;
	/** Non-empty when an uploaded snapshot claims a different host than the submitted target. */
	attributionError?: string;
};

/** A stored MHTML snapshot to read as a capture, with what is known of the page it holds. */
export type MhtmlSnapshotOptions = {
	/** Raw MHTML (decoded bytes), parsed locally: no browser ever loads it. */
	mhtmlSnapshot: Buffer;
	/** Original user-submitted URL. */
	url: string;
	/** Original location represented by the retained MHTML document, when known. */
	archivedUrl?: string;
	/** Exact response hops associated with the retained MHTML document, when known. */
	navigationHops?: WebsiteNavigationHop[];
	/** Only true for MHTML read back from this service's own stored artifact. */
	trustMhtmlDocumentLocation?: boolean;
	/** The verification gate the retained MHTML was captured behind, when known. */
	verificationGate?: WebsiteVerificationGate;
	/** Kit resources the original live capture of the retained MHTML received. */
	kitResources?: WebsiteKitResource[];
	/** Hidden frames the original live capture of the retained MHTML recorded. */
	hiddenFrames?: WebsiteHiddenFrame[];
	/** The browser the retained MHTML was captured with. */
	device?: WebsiteDevice;
};

/** How a site visit walks on from its first page: the visiting agent, in the same browser and tab. */
export type SiteWalk = {
	canaries: ExfiltrationCanaries;
	agent: VisitAgent;
	/** Extra instructions for the visiting agent, on top of the walk itself. */
	instructions?: string;
	live?: (event: SiteVisitLiveEvent) => void;
};

export type SiteVisitOptions = {
	url: string;
	/** The browser the visit presents; a phone ignores `visitor`. */
	device?: WebsiteDevice;
	/** The reporter's own browser, which a desktop visit presents instead of Google Chrome on Windows. */
	visitor?: BrowserIdentity;
	/**
	 * Visit over this route only, without the fallbacks across routes: the
	 * visit a CAPTCHA or browser check blocked is repeated from another network.
	 */
	egress?: FabricEgress;
	/**
	 * The live view of the visit, opened by the caller in `loading` mode: its
	 * viewers watch every route's browser load the site, then the walk.
	 * The caller closes it.
	 */
	control?: VisitControl;
	/** Cancels the visit at its next step: no further browser, wait or walk. */
	signal?: AbortSignal;
	/** Waits between attempts to load the site after a browser-service failure (`withBrowserBackoff`); none by default. */
	backoffMs?: readonly number[];
	/**
	 * Decide from the first page (step 0) whether the visiting agent walks
	 * on, in the same browser: a walk, or nothing to stop there (no agent,
	 * no model cost). Called for every first page, a decoy too, but a decoy
	 * (`cloaking.outcome === "unresolved"`) is never walked: the agent would
	 * only walk the decoy.
	 */
	walk?: (initial: WebsiteArchiveResult) => Promise<SiteWalk | undefined> | SiteWalk | undefined;
};

/** A site visit: its first page, and the walk from it when there was one. */
export type SiteVisit = {
	initial: WebsiteArchiveResult;
	recording?: SiteVisitRecording<WebsiteArchiveResult>;
};

export type SiteVisitDependencies = {
	getBrowser?: typeof getBrowser;
	/** Whether a host every route failed to tunnel to is gone from DNS. */
	confirmHostNxdomain?: typeof confirmHostNxdomain;
	/** Test seam for the bounded wait on an interstitial (a bot check, a dismissed provider warning) to be replaced by the site. */
	interstitialSettleMs?: number;
	/** Test seam for the bounded wait on the document's own rendering requests (network idle). */
	renderSettleMs?: number;
	/** Test seam for how long one screenshot may take before the page is captured without one. */
	screenshotTimeoutMs?: number;
	/** Test seams for a visit: its budget, how often it looks at the page, and how long a changed page must stay the same. */
	visitBudgetMs?: number;
	visitPollMs?: number;
	visitStepQuietMs?: number;
};

/**
 * What a fake human-verification gate revealed: the kit's own "I'm not a robot"
 * control, drawn by the kit (in the page or a frame of its own) rather than by
 * a captcha provider, which only swaps in the real page once clicked.
 */
export type WebsiteVerificationGate = {
	/** The control's own caption, e.g. "I'm not a robot". */
	label: string;
};


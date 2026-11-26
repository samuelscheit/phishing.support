import type { FabricEgress } from "../../browser/fabric";
import type { BrowserIdentity, getBrowser } from "../../browser";
import type { ExfiltrationCanaries } from "../../exfiltration/types";
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
	/** The open browser of a live capture made with `keepSession`. */
	session?: WebsitePageSession;
};

/**
 * A live capture's browser, kept open on the captured page: the flow acts on
 * that page as a visitor would (same cookies, same session, same variant of
 * a kit that changes per visit) and captures what it then shows.
 */
export type WebsitePageSession = {
	/**
	 * Walk the site from the captured page with the visiting agent, recording
	 * each page it reaches (its hops start where the step before ended), the
	 * network traffic, and every download.
	 */
	visit(params: WebsiteVisitParams): Promise<SiteVisitRecording<WebsiteArchiveResult>>;
	/** Release the browser; later calls do nothing. */
	close(): Promise<void>;
};

export type WebsiteVisitParams = {
	canaries: ExfiltrationCanaries;
	agent: VisitAgent;
	/** Extra instructions for the visiting agent, on top of the walk itself. */
	instructions?: string;
	live?: (event: SiteVisitLiveEvent) => void;
	/** Lets people watching the visit drive it. */
	control?: VisitControl;
	signal?: AbortSignal;
};

export type ArchiveWebsiteOptions = {
	/** Raw MHTML (decoded bytes). It is parsed locally; Fabric browsers never receive an app-local file:// URL. */
	mhtmlSnapshot?: Buffer;
	/** Original user-submitted URL. */
	url: string;
	/** The page whose link a live capture follows; the browser sends it as the Referer, as a visitor's would. */
	referrer?: string;
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
	/** The browser a live capture presents, and the retained MHTML was captured with. */
	device?: WebsiteDevice;
	/** The reporter's own browser, which a desktop capture presents instead of Google Chrome on Windows. */
	visitor?: BrowserIdentity;
	/**
	 * Keep the live capture's browser open as the result's `session`, so the
	 * caller can act on the captured page in the same visit; the caller closes it.
	 */
	keepSession?: boolean;
	/**
	 * Capture over this route only, without the fallbacks across routes: the
	 * visit a CAPTCHA or browser check blocked is repeated from another network.
	 */
	egress?: FabricEgress;
};

export type WebsiteArchiveDependencies = {
	getBrowser?: typeof getBrowser;
	/** Test seam for the bounded wait on a self-replacing HTTP error document. */
	errorDocumentSettleMs?: number;
	/** Test seam for the bounded wait on a page's own script navigation. */
	scriptNavigationSettleMs?: number;
	/** Test seam for the bounded wait on the captured document's own rendering requests. */
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


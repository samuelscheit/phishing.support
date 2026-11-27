import { type HTTPResponse, type Page } from "rebrowser-puppeteer-core";

import { getBrowser, getBrowserPage } from "../../browser";
import { agentAddressOf } from "../../browser/browser";
import { ClipboardRecorder } from "../../browser/clipboard";
import { FABRIC_EGRESS_LABEL, type FabricEgress } from "../../browser/fabric";
import { presentIdentityToNewTab, presentIdentityToPage } from "../../browser/page";
import { observedPuppeteerResponse, observeSessionResponses } from "../../browser/tab_traffic";
import { targetIdOf, type TabSetup, type VisitorTab } from "../../browser/visitor_tabs";
import { errorText } from "../../util/error_text";
import { startSiteRecording, type SiteRecording, type SiteVisitRecording } from "../../site_visit/visit";
import type { VisitControl } from "../../site_visit/control";
import { hiddenFrames, recordFrameTraffic, type FrameTrafficRecorder } from "../visit/hidden_frames";
import { passProviderWarning } from "../analysis/provider_warning";
import { actionResultHops, documentNavigationHops, isDocumentAnswer, isNetworkDocument, recordTab, type CapturedChain, type TabRecording } from "../visit/tab_recording";
import { interceptDocumentAnswers } from "../visit/document_bodies";
import type { WebsiteProviderWarning } from "../types";
import { BrowserInfrastructureError, isBrowserInfrastructureFailure, WebsiteUnreachableError } from "./errors";
import { getMhtmlArchiveLocation, parseMhtmlSnapshot } from "./mhtml";
import { capturePaintedScreenshot } from "./screenshot";
import { WEBSITE_INTERSTITIAL_SETTLE_MS, settleInterstitial, turnedAway } from "./interstitial";
import { WEBSITE_RENDER_SETTLE_MS, followScriptedDocument, settleRendering } from "./settle";
import type { SiteVisitDependencies, SiteVisitOptions, SiteWalk, WebsiteArchiveResult } from "./types";
import { passVerificationGate } from "./verification";

const WEBSITE_NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * The http(s) address a captured main-frame document belongs to. Kits that
 * fetch their real page and swap it in through `location.replace(blob:...)`
 * leave a blob: document of their own origin in the main frame; it is still the
 * page the visitor loaded. Anything else that is not http(s), such as
 * Chromium's own chrome-error:// page, belongs to no site.
 */
function documentAddress(pageUrl: string, loadedUrl: string): string | undefined {
	const page = new URL(pageUrl);
	if (/^https?:$/i.test(page.protocol)) return page.toString();
	if (page.protocol === "blob:" && page.origin === new URL(loadedUrl).origin) return loadedUrl;
	return undefined;
}

/** A tab of a live page: what was recorded of it, and where the step before it ended. */
type RecordedTab = {
	recording: TabRecording;
	/** Its frames' traffic, recorded once puppeteer has its page. */
	frameTraffic?: FrameTrafficRecorder;
	/** The address the tab loaded, until a document says otherwise. */
	loadedUrl?: string;
	/** Its documents before this index belong to steps already recorded. */
	stepFrom: number;
};

/** The site loaded over one route: its first page (step 0), and the open browser the visit walks on in. */
export type LivePage = {
	initial: WebsiteArchiveResult;
	/** Walk on from the first page with the visiting agent; once. */
	walk(walk: SiteWalk & { control?: VisitControl; signal?: AbortSignal }): Promise<SiteVisitRecording<WebsiteArchiveResult>>;
	/** Stop recording and release the browser; later calls do nothing. */
	close(): Promise<void>;
};

/**
 * Load the site over one route in a browser of its own and capture its first
 * page. Everything the visit records (the tab's document answers and
 * traffic, its clipboard, every request and download of every tab) starts
 * before the first request; the live view shows the tab from then on. A
 * failure is handed to `failed` while the browser is still open (the live
 * view lets go of its tab first), then the browser is closed.
 */
export async function openLivePage(options: SiteVisitOptions, egress: FabricEgress, dependencies: SiteVisitDependencies, failed: (error: unknown) => Promise<void>): Promise<LivePage> {
	const { url, control, signal } = options;
	const route = FABRIC_EGRESS_LABEL[egress];
	let close = async () => undefined as void;
	try {
		control?.setStatus(`Starting browser via ${route}…`);
		const browser = await (dependencies.getBrowser ?? getBrowser)(egress, signal ? { signal } : {}).catch((error: unknown) => {
			signal?.throwIfAborted();
			throw new BrowserInfrastructureError(`Browser service unavailable: ${errorText(error)}`, { cause: error });
		});
		let recording: SiteRecording | undefined;
		let stopAnswers: (() => Promise<void>) | undefined;
		let closing: Promise<void> | undefined;
		close = () => closing ??= (async () => {
			await stopAnswers?.().catch(() => undefined);
			await recording?.stop().catch(() => undefined);
			await browser.close();
		})();

		// Browser Fabric owns the leased profile context. Creating an
		// application-side incognito context would bypass that profile and egress
		// boundary, so visits always use the Fabric lease's default context.
		const device = options.device ?? "desktop";
		// The tab the browser already has, which the visiting agent attaches to as well: both must see the same tab.
		const context = browser.defaultBrowserContext();
		const [existing] = await context.pages();
		const { page, userAgent, identity } = await getBrowserPage(existing ?? await context.newPage(), device, options.visitor);

		// The visitor's tab's documents: the submitted page, where its script sent
		// the visitor (even from its <head>, before the navigation resolves), what
		// a clicked verification gate navigated to, and what each page action opened.
		const visitorTab: RecordedTab = { recording: recordTab(), frameTraffic: recordFrameTraffic(page), loadedUrl: url, stepFrom: 0 };
		// Every answer of the tab with when it arrived, and the body of every page, interstitials that navigate on at once included.
		// The session presents the tab's identity: a session attached later without it resets navigator.platform,
		// so everything else the visit records on the tab shares it.
		const recordingSession = await page.target().createCDPSession().catch((error: unknown) => {
			console.warn(`The visitor's tab of ${url} cannot be recorded: ${errorText(error)}`);
			return undefined;
		});
		stopAnswers = recordingSession && await interceptDocumentAnswers(recordingSession, targetIdOf(page.target()), visitorTab.recording.recordAnswer, identity.override)
			.catch((error: unknown) => {
				console.warn(`The document answers of ${url} cannot be recorded: ${errorText(error)}`);
				return undefined;
			});
		// What the site puts on the clipboard from its first page on: a fake verification the visit clicks may copy its command.
		const clipboard = new ClipboardRecorder();
		if (recordingSession) {
			await clipboard.attach(recordingSession).catch((error: unknown) => console.warn(`The clipboard writes of ${url} cannot be recorded: ${errorText(error)}`));
		}
		/** The tabs the site opens and what was recorded of each. */
		const openedTabs = new Map<string, RecordedTab>();
		/**
		 * A tab the site opened is recorded from its first request, as the visitor's own browser shows it.
		 * Its frames' traffic is recorded once puppeteer has its page, so a frame of its first load is
		 * listed as hidden without the code it ran.
		 */
		const recordOpenedTab: TabSetup = async (tab) => {
			if (!tab.opener) return;
			const recorded: RecordedTab = { recording: recordTab(), stepFrom: 0 };
			openedTabs.set(tab.targetId, recorded);
			observeSessionResponses(tab.session, tab.targetId, recorded.recording.observe);
			// The visit holds the tab's document responses already; it reads each page's body for this recording.
			tab.recordDocumentAnswer = recorded.recording.recordAnswer;
			await presentIdentityToNewTab(tab, identity);
			void tab.pageReady.then(async (shown) => {
				recorded.frameTraffic = recordFrameTraffic(shown);
				await presentIdentityToPage(shown, identity);
			}).catch(() => undefined);
		};
		// Every request and download of every tab, from the first load on: a drive-by download of the page itself is kept.
		recording = await startSiteRecording({ browser, page, userAgentOverride: identity.override, tabSetup: recordOpenedTab, clipboard });
		const tabs = recording.tabs;
		// Viewers watch the tab from before its first request.
		await control?.watchTab({ session: tabs.first.session, page }, `Loading page via ${route}…`);

		// The last final (non-redirect) main-frame document response, so a
		// document that replaces an interstitial is seen.
		let latestDocumentResponse = null as HTTPResponse | null;
		page.on("response", (response) => {
			const observed = observedPuppeteerResponse(page, response);
			visitorTab.recording.observe(observed);
			if (isDocumentAnswer(observed)) latestDocumentResponse = response;
		});

		// Navigation completes once the document exists; a stalled image or
		// third-party resource must not hold the entire visit open. Fabric owns
		// browser egress, so this navigation needs no app-level interception layer.
		// Whatever HTTP status the site answered with, its page is what a
		// visitor sees (kits serve their pages with 403, 404 or 500 too): the
		// route fails only when the navigation got no page, or the page it got
		// turned this network away (see `turnedAway`).
		let navigationResponse = await page.goto(url, { waitUntil: "domcontentloaded", timeout: WEBSITE_NAVIGATION_TIMEOUT_MS }).catch((error: unknown) => {
			signal?.throwIfAborted();
			// A browser that died under the navigation says nothing about the site.
			if (isBrowserInfrastructureFailure(error)) throw new BrowserInfrastructureError(errorText(error), { cause: error });
			throw new WebsiteUnreachableError(egress, errorText(error));
		});
		signal?.throwIfAborted();
		// A kit that swaps in its blob: page before DOMContentLoaded makes the
		// navigation resolve with that blob: document; the site's own response is
		// the document the visitor loaded.
		if (navigationResponse && !isNetworkDocument(navigationResponse.url())) navigationResponse = latestDocumentResponse;
		// A provider's warning or a bot check may stand before the site: the
		// page that replaces it is the site.
		const providerWarning: WebsiteProviderWarning | undefined = await passProviderWarning(page);
		signal?.throwIfAborted();
		if (navigationResponse) {
			const replaced = await settleInterstitial(page, () => latestDocumentResponse, navigationResponse, {
				dismissed: providerWarning !== undefined,
				settleMs: dependencies.interstitialSettleMs ?? WEBSITE_INTERSTITIAL_SETTLE_MS,
				...(signal ? { signal } : {}),
			});
			if (replaced) {
				visitorTab.recording.discardBefore(replaced.url());
				navigationResponse = replaced;
			}
			if (replaced || providerWarning) await control?.follow();
		}
		signal?.throwIfAborted();

		// Site builders and single-page apps build the visible page from XHR
		// responses after DOMContentLoaded; the network going idle says they are done.
		const renderSettleMs = dependencies.renderSettleMs ?? WEBSITE_RENDER_SETTLE_MS;
		await settleRendering(page, renderSettleMs);
		// A cloaking interstitial loads, asks its server where to send this visitor,
		// then navigates the main frame by script, while it loads or renders. The
		// visit captures the page the visitor ends up on, rendered in turn, and the
		// scripted step is its own hop. The MHTML's own Chromium URL header
		// identifies the captured document either way.
		const scripted = await followScriptedDocument(page, latestDocumentResponse, navigationResponse, renderSettleMs);
		signal?.throwIfAborted();
		await control?.follow();
		// A navigation that ended in a network failure, or in an HTTP answer
		// without a page to show, leaves Chromium's own error document
		// (chrome-error://) in the main frame. That is not a site: the
		// destination was unreachable.
		const loadedUrl = visitorTab.loadedUrl = (scripted ?? navigationResponse)?.url() ?? url;
		if (!documentAddress(page.url(), loadedUrl)) {
			const failure = latestDocumentResponse !== navigationResponse ? latestDocumentResponse : null;
			throw new WebsiteUnreachableError(egress, failure
				? `the page sent the visitor to ${failure.request().redirectChain()[0]?.url() ?? failure.url()}, which ended in HTTP ${failure.status()} at ${failure.url()}`
				: "the page's own navigation failed before reaching a site");
		}
		// A bot check that never passed, a WAF's block page or a bare gateway
		// error is this network turned away, not the site: the next route may
		// get the site.
		const turned = await turnedAway(page, scripted ?? navigationResponse);
		signal?.throwIfAborted();
		if (turned) throw new WebsiteUnreachableError(egress, turned);
		const verificationGate = await passVerificationGate(page, renderSettleMs);
		if (verificationGate) await control?.follow();
		signal?.throwIfAborted();

		/** A tab's page as it stands: screenshot, MHTML, and the hops that led to it. */
		const snapshot = async (shown: Page, tab: RecordedTab, chainTo: (capturedDocumentUrl: string) => CapturedChain): Promise<WebsiteArchiveResult> => {
			const documentUrl = tab.recording.documents.at(-1)?.url ?? tab.loadedUrl ?? shown.url();
			const screenshotUrl = documentAddress(shown.url(), documentUrl);
			const screenshotBytes = await capturePaintedScreenshot(shown, dependencies.screenshotTimeoutMs);
			const cdp = await shown.target().createCDPSession();
			const resolvedMhtml = Buffer.from((await cdp.send("Page.captureSnapshot", { format: "mhtml" })).data, "utf-8");
			await cdp.detach().catch(() => undefined);
			const documentHtml = await shown.evaluate(() => document.documentElement.outerHTML).catch(() => undefined);
			const capturedDocumentUrl = getMhtmlArchiveLocation(resolvedMhtml) ?? documentAddress(shown.url(), documentUrl) ?? shown.url();
			tab.recording.settleAnswers();
			const chain = chainTo(capturedDocumentUrl);
			const capturedDocument = await parseMhtmlSnapshot({ url, archivedUrl: capturedDocumentUrl, navigationHops: chain.hops, mhtmlSnapshot: resolvedMhtml });
			const frames = tab.frameTraffic ? await hiddenFrames(shown, tab.frameTraffic, userAgent) : [];
			return {
				...capturedDocument,
				...(chain.bodies.length ? { hopBodies: chain.bodies } : {}),
				route,
				egress,
				screenshotPng: screenshotBytes && screenshotUrl === capturedDocumentUrl ? Buffer.from(screenshotBytes) : undefined,
				...(documentHtml ? { documentHtml } : {}),
				kitResources: await tab.recording.kitResources(),
				...(frames.length ? { hiddenFrames: frames } : {}),
				...(device !== "desktop" ? { device } : {}),
				userAgent,
				...(verificationGate ? { verificationGate } : {}),
				...(providerWarning ? { providerWarning } : {}),
			};
		};

		const captureInitial = () => snapshot(page, visitorTab, (capturedDocumentUrl) => documentNavigationHops(visitorTab.recording.documents, capturedDocumentUrl));
		let initial: WebsiteArchiveResult;
		try {
			initial = await captureInitial();
		} catch (error) {
			signal?.throwIfAborted();
			// A timed script redirect firing mid-snapshot destroys the previous page's execution context:
			// follow the destination document and snapshot once more rather than blaming the browser service.
			const navigatedMidSnapshot = /Execution context was destroyed|Cannot find context|Navigating frame was detached/i.test(errorText(error))
				&& (latestDocumentResponse !== (scripted ?? navigationResponse) || page.url() !== loadedUrl);
			if (!navigatedMidSnapshot) throw error;
			const followed = await followScriptedDocument(page, latestDocumentResponse, scripted ?? navigationResponse, renderSettleMs);
			signal?.throwIfAborted();
			await control?.follow();
			const nextLoadedUrl = visitorTab.loadedUrl = (followed ?? latestDocumentResponse)?.url() ?? loadedUrl;
			if (!documentAddress(page.url(), nextLoadedUrl)) {
				throw new WebsiteUnreachableError(egress, "the page's own navigation failed before reaching a site");
			}
			initial = await captureInitial();
		}
		const walk: LivePage["walk"] = (params) => {
			// Each step of a walk holds the documents its tab received since that tab's step before.
			visitorTab.stepFrom = visitorTab.recording.documents.length;
			return recording!.walk({
				agentAddress: agentAddressOf(browser) ?? browser.wsEndpoint(),
				url: page.url(),
				touch: identity.screen !== "desktop",
				...params,
				snapshot: (tab: VisitorTab) => {
					const recorded = openedTabs.get(tab.targetId) ?? visitorTab;
					const { documents } = recorded.recording;
					const from = recorded.stepFrom;
					recorded.stepFrom = documents.length;
					return snapshot(tab.page!, recorded, (capturedDocumentUrl) => actionResultHops(documents.slice(from), documents.at(-1), capturedDocumentUrl));
				},
				...(dependencies.visitBudgetMs ? { budgetMs: dependencies.visitBudgetMs } : {}),
				...(dependencies.visitPollMs ? { pollMs: dependencies.visitPollMs } : {}),
				...(dependencies.visitStepQuietMs ? { stepQuietMs: dependencies.visitStepQuietMs } : {}),
			});
		};
		return { initial, walk, close };
	} catch (error) {
		await failed(error).catch(() => undefined);
		await close().catch(() => undefined);
		throw error;
	}
}

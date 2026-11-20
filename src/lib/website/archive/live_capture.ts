import { type HTTPResponse, type Page } from "rebrowser-puppeteer-core";

import { getBrowser, getBrowserPage } from "../../browser";
import { agentAddressOf } from "../../browser/browser";
import { FABRIC_EGRESS_LABEL, type FabricEgress } from "../../browser/fabric";
import { presentIdentityToNewTab, presentIdentityToPage } from "../../browser/page";
import { observedPuppeteerResponse, observeSessionResponses } from "../../browser/tab_traffic";
import type { TabSetup, VisitorTab } from "../../browser/visitor_tabs";
import { errorText } from "../../util/error_text";
import { squash } from "../../util/text";
import { runSiteVisit } from "../../site_visit/visit";
import { hiddenFrames, recordFrameTraffic, type FrameTrafficRecorder } from "../visit/hidden_frames";
import { passProviderWarning } from "../analysis/provider_warning";
import { actionResultHops, documentNavigationHops, isDocumentAnswer, isNetworkDocument, recordTab, type TabRecording } from "../visit/tab_recording";
import type { WebsiteNavigationHop, WebsiteProviderWarning } from "../types";
import { BrowserInfrastructureError, isBrowserInfrastructureFailure, WebsiteUnreachableError } from "./errors";
import { archiveMhtmlSnapshot, getMhtmlArchiveLocation } from "./mhtml";
import { capturePaintedScreenshot } from "./screenshot";
import {
	WEBSITE_ERROR_DOCUMENT_SETTLE_MS,
	WEBSITE_RENDER_SETTLE_MS,
	WEBSITE_SCRIPT_NAVIGATION_SETTLE_MS,
	settleErrorDocument,
	settleRendering,
	settleScriptNavigation,
} from "./settle";
import type { ArchiveWebsiteOptions, WebsiteArchiveDependencies, WebsiteArchiveResult, WebsitePageSession, WebsiteVisitParams } from "./types";
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


/** A tab of a live capture: what was recorded of it, and where the step before it ended. */
type CaptureTab = {
	recording: TabRecording;
	/** Its frames' traffic, recorded once puppeteer has its page. */
	frameTraffic?: FrameTrafficRecorder;
	/** The address the captured tab loaded, until a document says otherwise. */
	loadedUrl?: string;
	/** Its documents before this index belong to steps already recorded. */
	stepFrom: number;
};

/** A live capture: the captured page, and the open browser the flow can keep acting in. */
export type LiveCapture = { archive: WebsiteArchiveResult; session: WebsitePageSession };

export async function openLiveCapture(options: ArchiveWebsiteOptions, egress: FabricEgress, dependencies: WebsiteArchiveDependencies): Promise<LiveCapture> {
	const { url, referrer } = options;
	const browser = await (dependencies.getBrowser ?? getBrowser)(egress).catch((error: unknown) => {
		throw new BrowserInfrastructureError(`Browser service unavailable: ${errorText(error)}`, { cause: error });
	});
	let open = true;
	const close = async () => {
		if (!open) return;
		open = false;
		await browser.close();
	};
	try {
		// Browser Fabric owns the leased profile context. Creating an
		// application-side incognito context would bypass that profile and egress
		// boundary, so archive work always uses the Fabric lease's default context.
		const device = options.device ?? "desktop";
		// The tab the browser already has, which the visiting agent attaches to
		// as well: both must see the same tab.
		const context = browser.defaultBrowserContext();
		const [existing] = await context.pages();
		const { page, userAgent, identity } = await getBrowserPage(existing ?? await context.newPage(), device, options.visitor);

		// The captured tab's documents: the submitted page, where its script sent
		// the visitor (even from its <head>, before the navigation resolves), what
		// a clicked verification gate navigated to, and what each page action opened.
		const captured: CaptureTab = { recording: recordTab(), frameTraffic: recordFrameTraffic(page), loadedUrl: url, stepFrom: 0 };
		// The last final (non-redirect) main-frame document response, so a
		// document that replaces an error interstitial is seen with its status.
		let latestDocumentResponse = null as HTTPResponse | null;
		page.on("response", (response) => {
			const observed = observedPuppeteerResponse(page, response);
			captured.recording.observe(observed);
			if (isDocumentAnswer(observed)) latestDocumentResponse = response;
		});

		// Navigation completes once the document exists; a stalled image or
		// third-party resource must not hold the entire analysis open. Fabric owns
		// browser egress, so this evidence-only navigation does not need an
		// app-level interception layer.
		let navigationResponse = await page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: WEBSITE_NAVIGATION_TIMEOUT_MS,
			// A kit's later page may check that the visitor came from its earlier one.
			...(referrer ? { referer: referrer } : {}),
		}).catch((error: unknown) => {
			// A browser that died under the navigation says nothing about the site.
			if (isBrowserInfrastructureFailure(error)) throw new BrowserInfrastructureError(errorText(error), { cause: error });
			throw new WebsiteUnreachableError(egress, errorText(error));
		});
		// A kit that swaps in its blob: page before DOMContentLoaded makes the
		// navigation resolve with that blob: document; the site's own response is
		// the document the visitor loaded.
		if (navigationResponse && !isNetworkDocument(navigationResponse.url())) navigationResponse = latestDocumentResponse;
		let providerWarning: WebsiteProviderWarning | undefined;
		if (navigationResponse && !navigationResponse.ok()) {
			providerWarning = await passProviderWarning(page, { humanCheckMs: dependencies.humanCheckMs, captchaProviderFrame: dependencies.captchaProviderFrame });
			const settled = await settleErrorDocument(page, () => latestDocumentResponse, dependencies.errorDocumentSettleMs ?? WEBSITE_ERROR_DOCUMENT_SETTLE_MS);
			if (!settled) {
				const title = squash(await page.title().catch(() => ""));
				const status = latestDocumentResponse?.status() ?? navigationResponse.status();
				throw new WebsiteUnreachableError(egress, `HTTP ${status}${title ? ` ("${title}")` : ""}`);
			}
			navigationResponse = settled;
		}

		// A cloaking interstitial loads, asks its server where to send this visitor,
		// then navigates the main frame by script. Wait for that navigation so the
		// capture holds the page the visitor ends up on, and record the scripted
		// step as its own hop. The MHTML's own Chromium URL header identifies the
		// captured document either way.
		const scriptNavigation = await settleScriptNavigation(page, () => latestDocumentResponse, navigationResponse, dependencies.scriptNavigationSettleMs ?? WEBSITE_SCRIPT_NAVIGATION_SETTLE_MS);
		// A navigation the page started that ended in an HTTP error or a network
		// failure leaves Chromium's own error document (chrome-error://) in the
		// main frame. That is not a site: the destination was unreachable.
		const loadedUrl = captured.loadedUrl = (scriptNavigation ?? navigationResponse)?.url() ?? url;
		if (!documentAddress(page.url(), loadedUrl)) {
			const failed = latestDocumentResponse !== navigationResponse ? latestDocumentResponse : null;
			throw new WebsiteUnreachableError(egress, failed
				? `the page sent the visitor to ${failed.request().redirectChain()[0]?.url() ?? failed.url()}, which ended in HTTP ${failed.status()} at ${failed.url()}`
				: "the page's own navigation failed before reaching a site");
		}
		const renderSettleMs = dependencies.renderSettleMs ?? WEBSITE_RENDER_SETTLE_MS;
		await settleRendering(page, renderSettleMs);
		const verificationGate = await passVerificationGate(page, renderSettleMs);

		/** A tab's page as it stands: screenshot, MHTML, and the hops that led to it. */
		const snapshot = async (shown: Page, tab: CaptureTab, hopsTo: (capturedDocumentUrl: string) => WebsiteNavigationHop[]): Promise<WebsiteArchiveResult> => {
			const documentUrl = tab.recording.documents.at(-1)?.url ?? tab.loadedUrl ?? shown.url();
			const screenshotUrl = documentAddress(shown.url(), documentUrl);
			const screenshotBytes = await capturePaintedScreenshot(shown, dependencies.screenshotTimeoutMs);
			const cdp = await shown.target().createCDPSession();
			const resolvedMhtml = Buffer.from((await cdp.send("Page.captureSnapshot", { format: "mhtml" })).data, "utf-8");
			await cdp.detach().catch(() => undefined);
			const documentHtml = await shown.evaluate(() => document.documentElement.outerHTML).catch(() => undefined);
			const capturedDocumentUrl = getMhtmlArchiveLocation(resolvedMhtml) ?? documentAddress(shown.url(), documentUrl) ?? shown.url();
			const capturedDocument = await archiveMhtmlSnapshot({ url, archivedUrl: capturedDocumentUrl, navigationHops: hopsTo(capturedDocumentUrl), mhtmlSnapshot: resolvedMhtml });
			const frames = tab.frameTraffic ? await hiddenFrames(shown, tab.frameTraffic, userAgent) : [];
			return {
				...capturedDocument,
				route: FABRIC_EGRESS_LABEL[egress],
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

		const visit = async (params: WebsiteVisitParams) => {
			if (!open) throw new Error("The capture's browser is already closed.");
			// Each step of a visit holds the documents its tab received since that tab's step before.
			captured.stepFrom = captured.recording.documents.length;
			const opened = new Map<string, CaptureTab>();
			/**
			 * A tab the site opened is recorded from its first request, as the visitor's own browser shows it.
			 * Its frames' traffic is recorded once puppeteer has its page, so a frame of its first load is
			 * listed as hidden without the code it ran.
			 */
			const recordOpenedTab: TabSetup = async (tab) => {
				if (!tab.opener) return;
				const recorded: CaptureTab = { recording: recordTab(), stepFrom: 0 };
				opened.set(tab.targetId, recorded);
				observeSessionResponses(tab.session, tab.targetId, recorded.recording.observe);
				await presentIdentityToNewTab(tab, identity);
				void tab.pageReady.then(async (shown) => {
					recorded.frameTraffic = recordFrameTraffic(shown);
					await presentIdentityToPage(shown, identity);
				}).catch(() => undefined);
			};
			return runSiteVisit({
				browser,
				page,
				agentAddress: agentAddressOf(browser) ?? browser.wsEndpoint(),
				userAgent,
				url: page.url(),
				...params,
				tabSetup: recordOpenedTab,
				snapshot: (tab: VisitorTab) => {
					const recorded = opened.get(tab.targetId) ?? captured;
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

		const archive = await snapshot(page, captured, (capturedDocumentUrl) => documentNavigationHops(captured.recording.documents, capturedDocumentUrl));
		return { archive, session: { visit, close } };
	} catch (error) {
		await close();
		throw error;
	}
}

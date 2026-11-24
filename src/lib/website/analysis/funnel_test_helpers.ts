import sharp from "sharp";

import type { AnalysisClient } from "../../analysis/run";
import { CHECKOUT_TEXT, LURE_TEXT, PRODUCTION_URLS } from "../../abuse/funnel/test_fixtures";
import { scriptedVisitSession } from "../../site_visit/test_helpers";
import type { WebsiteArchiveResult } from "../archive/types";
import type { WebsiteNavigationHop } from "../types";
import type { WebsiteAnalysisDependencies } from "./analysis_types";

/**
 * The production affiliate funnel as the website analysis meets it: the
 * captures of its chain, and a model that judges its pages and the chain
 * as the production case was judged. Shared by the funnel and offer-rotation
 * tests.
 */

export const PNG = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#ffffff" } }).png().toBuffer();
export const START = Date.parse("2026-11-23T09:14:02.000Z");
const NOTHING = { finding: "insufficient_evidence", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false };
export const LURE_HTML = `<html><head><title>Your Financial Assist</title></head><body>${LURE_TEXT.split("\n").map((line) => `<p>${line}</p>`).join("")}</body></html>`;
export const CHECKOUT_HTML = `<html><head><title>Zatos Antivirus - Checkout</title></head><body>${CHECKOUT_TEXT.split("\n").map((line) => `<p>${line}</p>`).join("")}</body></html>`;

/**
 * The other offer the production link rotated to (the reporter's own click):
 * a fake cloud-storage renewal on DigitalOcean Spaces, behind a tracker the
 * funnel does not know.
 */
export const CLOUD_STORAGE_URLS = {
	tracker: "https://safe.cloudforstorage.com/9a4c1f0e-2b7d-4f3a-9c61-5e8d2a7b4c13",
	scam: "https://cloudstore-nnn6.ric1.digitaloceanspaces.com/index.html",
} as const;
export const CLOUD_STORAGE_TEXT = "Your payment method has expired\nYour Cloud Storage has been Disabled\nRENEW NOW";
export const CLOUD_STORAGE_HTML = `<html><head><title>Cloud Storage</title></head><body>${CLOUD_STORAGE_TEXT.split("\n").map((line) => `<p>${line}</p>`).join("")}</body></html>`;

export type ModelCall = { kind: "site" | "funnel" | "narrative"; input: string };

/**
 * The model of the production case: no page of the funnel is phishing by
 * itself; the chain as a whole is a fake application for assistance that ends
 * in an antivirus subscription. The cloud-storage renewal takes card details
 * for a storage plan nobody had: payment fraud. A chain whose lure names what
 * it promotes is judged not deceptive.
 */
export function funnelModel(calls: ModelCall[], answers: { phishingLure?: boolean } = {}): AnalysisClient {
	let call = 0;
	return {
		responses: {
			create: async (options: { input: unknown; text?: { format?: { name?: string } } }) => {
				const input = JSON.stringify(options.input);
				const kind = options.text?.format?.name === "DeceptiveFunnelClassification" ? "funnel" : options.text ? "site" : "narrative";
				calls.push({ kind, input });
				// The pages as the input names them: the lure's and the merchant's.
				const ref = (role: string) => input.match(new RegExp(`page_ref: (page-\\d+)\\\\nrole: ${role}`))?.[1] ?? "";
				const site = answers.phishingLure && input.includes("Application status: Pre-approved")
					? { ...NOTHING, finding: "phishing", phishingBasis: "payment_fraud", evidenceQuote: "Complete the final step to submit your application." }
					: input.includes("Your Cloud Storage has been Disabled")
						? { ...NOTHING, finding: "phishing", phishingBasis: "payment_fraud", evidenceQuote: "Your Cloud Storage has been Disabled" }
						: NOTHING;
				const answer = kind === "narrative" ? "The chain leads through affiliate tracking links into a paid offer." : JSON.stringify(kind === "site" ? site
					: input.includes("Your Financial Assist") ? {
						finding: "deceptive_funnel",
						deceptionKind: "fake_application",
						lureClaim: "The visitor's application for financial assistance was pre-approved and needed one final step.",
						reality: "A $19.98 per month antivirus subscription checkout.",
						lureQuotes: [{ pageRef: ref("lure"), quote: "Your Financial Assist\nComplete the final step to submit your application." }],
						offerQuote: { pageRef: ref("merchant"), quote: "$19.98/month" },
					}
					: { finding: "not_deceptive", deceptionKind: "none", lureClaim: "", reality: "", lureQuotes: [], offerQuote: { pageRef: "", quote: "" } });
				call++;
				return (async function* () {
					yield { type: "response.completed", response: { id: `response-${call}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: answer }] }], usage: { total_tokens: 10 } } };
				})();
			},
		},
	} as unknown as AnalysisClient;
}

/** One response of the chain, arriving 700 ms after the one before it, as the production visit timed them. */
export function funnelHop(index: number, url: string, status: number, extra: Partial<WebsiteNavigationHop> = {}): WebsiteNavigationHop {
	return { index, url, hostname: new URL(url).hostname, status, receivedAt: new Date(START + index * 700).toISOString(), contentCaptured: false, ...extra };
}

/** A page the capture showed, its hops numbered from 0 within the page, the last one's body kept. */
export function capturedPage(url: string, html: string, text: string, hops: WebsiteNavigationHop[], session?: WebsiteArchiveResult["session"]): WebsiteArchiveResult {
	const last = hops.at(-1)!;
	return {
		requestedUrl: hops[0]!.url,
		url,
		hostname: new URL(url).hostname,
		navigationHops: hops.map((each, index) => ({ ...each, index, ...(each === last ? { contentType: "text/html", contentCaptured: true, bodyCaptured: true } : {}) })),
		hopBodies: [{ hopIndex: hops.length - 1, body: Buffer.from(html) }],
		archivedAt: new Date(Date.parse(last.receivedAt!) + 300),
		route: "residential exit",
		screenshotPng: PNG,
		mhtml: Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${url}\r\n\r\n${html}`, "utf8"),
		html: Buffer.from(html),
		text: Buffer.from(text),
		...(session ? { session } : {}),
	};
}

/**
 * The production chain of docs/design/redirect-chain-cases.md: the Everflow
 * link to the Voluum lure, whose CONTINUE the visit clicks, through the
 * base64 wrapper and CAKE's cookie check to the zatos.com checkout.
 */
export function productionVisit(link: string = PRODUCTION_URLS.everflowLink): WebsiteArchiveResult {
	const u = PRODUCTION_URLS;
	const checkout = capturedPage(u.checkout, CHECKOUT_HTML, CHECKOUT_TEXT, [
		funnelHop(4, u.voluumClick, 302, { redirectTo: u.wrapper }),
		funnelHop(5, u.wrapper, 302, { redirectTo: u.cakeLink }),
		funnelHop(6, u.cakeLink, 302, { redirectTo: u.cakeCookieCheck }),
		funnelHop(7, u.cakeCookieCheck, 302, { redirectTo: u.checkout }),
		funnelHop(8, u.checkout, 200),
	]);
	return capturedPage(u.lure, LURE_HTML, LURE_TEXT, [
		funnelHop(0, link, 302, { redirectTo: u.everflowRedirect }),
		funnelHop(1, u.everflowRedirect, 302, { redirectTo: u.voluumCampaign }),
		funnelHop(2, u.voluumCampaign, 302, { redirectTo: u.lure }),
		funnelHop(3, u.lure, 200),
	], scriptedVisitSession({ steps: [checkout] }));
}

/** The same link rotated to the cloud-storage renewal: Everflow, the unknown tracker, the scam page, which the walk leaves alone. */
export function cloudStorageVisit(link: string = PRODUCTION_URLS.everflowLink): WebsiteArchiveResult {
	const c = CLOUD_STORAGE_URLS;
	return capturedPage(c.scam, CLOUD_STORAGE_HTML, CLOUD_STORAGE_TEXT, [
		funnelHop(0, link, 302, { redirectTo: c.tracker }),
		funnelHop(1, c.tracker, 302, { redirectTo: c.scam }),
		funnelHop(2, c.scam, 200),
	], scriptedVisitSession());
}

/** The network boundaries of an analysis of the funnel: the capture given, the funnel's model, nothing else reached. */
export function funnelDependencies(capture: WebsiteAnalysisDependencies["archiveWebsite"], calls: ModelCall[], options: { phishingLure?: boolean; popular?: string[] } = {}): WebsiteAnalysisDependencies {
	return {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: funnelModel(calls, options),
		domainRegistration: async () => undefined,
		timestampEvidence: async () => undefined,
		browserBackoffMs: [1],
		downloadLookups: async () => [],
		popularDomains: async () => new Set(options.popular ?? []),
		archiveWebsite: capture,
	};
}

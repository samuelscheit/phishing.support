import { testRdapLocator } from "../../network/rdap_test_helpers";
import type { ResolverDependencies } from "../resolver/types";
import type { FunnelChain, FunnelHop, FunnelPage } from "./chain";

const CLICK = "584e52702a4f4436b6d677b95a955ee8";
const CEP = "Ib1rzRGvnI0nO-Csd6Er6nRrpaK8WGa0qxPC5nfF5rRyHo7VIbMQ0pfBaA3T1mx8";
const LP_TOKEN = "171195eb47ee06ab8010";

const CAKE_LINK = `https://miamitrk.com/?a=15065&c=181082&s1=128_&s2=dke0kbl56rbr55umj7k6ku34&s3=3079&lptoken=${LP_TOKEN}&clickid=${CLICK}`;
export const PRODUCTION_URLS = {
	everflowLink: "https://www.onlinesafetyall.com/6RNXHT/2HSS8TK/?sub1=3079&sub2=d2d5aa5e17414bd4a51fd8ea730f830a",
	everflowRedirect: "https://www.onlinesafetyall.com/6RNXHT/28DHQGH/?__rpt=0&__po=864&__ptid=83df736cd5f44c7c9c591bcf5bd74bce&__rpa=0&__rc=1&sub1=3079&sub2=d2d5aa5e17414bd4a51fd8ea730f830a",
	voluumCampaign: `https://wtrck.com/4df5378b-a236-4c67-b2d3-cbbb2e9d4b92?s1=128&s3=3079&clickid=${CLICK}`,
	lure: `https://ultimateprizesearch.com/exit-woops4-wwm.html?cep=${CEP}&lptoken=${LP_TOKEN}&s1=128&s3=3079&clickid=${CLICK}`,
	voluumClick: `https://wtrck.com/click/1?cep=${CEP}`,
	wrapper: `https://verify.sdsecurenetwork.com/redirect?target=BASE64${Buffer.from(CAKE_LINK).toString("base64")}`,
	cakeLink: CAKE_LINK,
	cakeCookieCheck: `${CAKE_LINK}&ch-redir=1&ckmxid=d0o41bd00000gu4vb1j0`,
	checkout: "https://www.zatos.com/special/av/ht/checkout.php?affid=15065&sub1=128_&sub2=dke0kbl56rbr55umj7k6ku34&sub3=43769-951152199",
} as const;

export const LURE_TEXT = [
	"Your Financial Assist",
	"Application status: Pre-approved",
	"You are one step away from receiving your assistance.",
	"Complete the final step to submit your application.",
	"CONTINUE",
].join("\n");

export const CHECKOUT_TEXT = [
	"Zatos Antivirus",
	"Total Protection - Special Offer",
	"$19.98/month",
	"Billed monthly. Cancel anytime.",
	"Complete your order",
].join("\n");

const START = Date.parse("2026-11-23T09:14:02.000Z");

function hop(index: number, url: string, status: number | null, redirectTo?: string): FunnelHop {
	return { index, url, hostname: new URL(url).hostname, status, ...(redirectTo ? { redirectTo } : {}), at: new Date(START + index * 700) };
}

/**
 * The production chain of docs/design/redirect-chain-cases.md (2026-11-23),
 * as one case records it; values the report did not show are filled in
 * with values of the same shape.
 */
export function productionChain(): FunnelChain {
	const u = PRODUCTION_URLS;
	const hops = [
		hop(0, u.everflowLink, 302, u.everflowRedirect),
		hop(1, u.everflowRedirect, 302, u.voluumCampaign),
		hop(2, u.voluumCampaign, 302, u.lure),
		hop(3, u.lure, 200),
		hop(4, u.voluumClick, 302, u.wrapper),
		hop(5, u.wrapper, 302, u.cakeLink),
		hop(6, u.cakeLink, 302, u.cakeCookieCheck),
		hop(7, u.cakeCookieCheck, 302, u.checkout),
		hop(8, u.checkout, 200),
	];
	const pages: FunnelPage[] = [
		{ hopIndex: 3, url: u.lure, title: "Your Financial Assist", text: LURE_TEXT, screenshot: { buffer: Buffer.from("lure-png"), mimeType: "image/png" }, capturedAt: new Date(START + 3 * 700 + 300) },
		{ hopIndex: 8, url: u.checkout, title: "Zatos Antivirus - Checkout", text: CHECKOUT_TEXT, screenshot: { buffer: Buffer.from("checkout-png"), mimeType: "image/png" }, capturedAt: new Date(START + 8 * 700 + 300) },
	];
	return { hops, pages, startedAt: new Date(START) };
}

/** A chain of `urls`, every one a redirect except those in `shown`, which showed a page with `text`. */
export function chainOf(urls: string[], shown: Record<number, string> = {}): FunnelChain {
	const hops = urls.map((url, index) => hop(index, url, index in shown ? 200 : 302, urls[index + 1]));
	const pages = Object.entries(shown).map(([index, text]) => ({ hopIndex: Number(index), url: urls[Number(index)]!, text, capturedAt: new Date(START + Number(index) * 700) }));
	return { hops, pages, startedAt: new Date(START) };
}

export type WebAnswer = { status?: number; body?: string; type?: string; location?: string } | Error;

/** A web where each URL answers as listed, everything else 404; records every request. */
export function web(answers: Record<string, WebAnswer>, extra: Partial<ResolverDependencies> = {}): ResolverDependencies & { requested: string[] } {
	const requested: string[] = [];
	return {
		requested,
		assertPublicHost: async () => undefined,
		rdapLocator: testRdapLocator,
		port43Query: async () => "",
		httpRetryAttempts: 1,
		port43Attempts: 1,
		...extra,
		fetch: async (input) => {
			const url = String(input);
			requested.push(url);
			const answer = answers[url];
			if (answer instanceof Error) throw answer;
			if (!answer) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
			const rdap = url.startsWith("https://rdap.");
			return new Response(answer.body ?? "", {
				status: answer.status ?? 200,
				headers: { "content-type": answer.type ?? (rdap ? "application/rdap+json" : "text/html; charset=utf-8"), ...(answer.location ? { location: answer.location } : {}) },
			});
		},
	};
}

export function rdapDomain(domain: string, holder?: { email: string; org?: string; name?: string }, registrarAbuse = "abuse@namecheap.com") {
	return {
		body: JSON.stringify({
			objectClassName: "domain",
			ldhName: domain.toUpperCase(),
			entities: [
				{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "NameCheap, Inc."]]], entities: [{ roles: ["abuse"], vcardArray: ["vcard", [["email", {}, "text", registrarAbuse]]] }] },
				...(holder ? [{ roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", holder.name ?? ""], ["org", {}, "text", holder.org ?? ""], ["email", {}, "text", holder.email]]] }] : []),
			],
		}),
	};
}

export const ZATOS_HOME = `<html><body><a href="https://help.zatos.com/knowledgebase/index-antivirus.php">Help</a><a href="https://help.zatos.com/terms/index-antivirus.php">Terms</a><img src="/zatosLogo-v1@2x.png"></body></html>`;

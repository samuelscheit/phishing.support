import type { FunnelChain } from "../../abuse/funnel/chain";
import { classifyDeceptiveFunnel, type DeceptiveFunnelFinding } from "../../abuse/funnel/classification";
import { DECEPTION_PHRASES } from "../../abuse/funnel/deception";
import { reportDeceptiveFunnel, type FunnelReportOutcome } from "../../abuse/funnel/report";
import type { ReporterMetadata } from "../../http/reporter_headers";
import type { WebsiteFunnel, WebsiteNavigationHop } from "../types";
import type { WebsiteShownPage } from "../visit/visit";
import type { WebsiteAnalysisDependencies } from "./analysis_types";
import { stepScreenshots } from "./evidence";

/**
 * The case's chain as the funnel reads it: every response with the time it
 * arrived, and every page the visit showed with its text and its stamped
 * screenshot. It starts when the first response arrived.
 */
export async function caseFunnelChain(submissionId: bigint, chain: readonly WebsiteNavigationHop[], pages: readonly WebsiteShownPage[]): Promise<FunnelChain> {
	const screenshots = new Map((await stepScreenshots(submissionId, pages.map(({ step }) => step))).map(({ step, png }) => [step, png]));
	const startedAt = chain.find((hop) => hop.receivedAt)?.receivedAt;
	return {
		hops: chain.map(({ index, url, hostname, status, redirectTo, receivedAt }) => ({ index, url, hostname, status, ...(redirectTo ? { redirectTo } : {}), ...(receivedAt ? { at: new Date(receivedAt) } : {}) })),
		pages: pages.map((page) => {
			const png = screenshots.get(page.step);
			return { hopIndex: page.hopIndex, url: page.url, ...(page.title ? { title: page.title } : {}), text: page.text, ...(png ? { screenshot: { buffer: png, mimeType: "image/png" as const } } : {}), capturedAt: page.capturedAt };
		}),
		startedAt: startedAt ? new Date(startedAt) : pages[0]?.capturedAt ?? new Date(),
	};
}

/**
 * Judge the whole chain as an affiliate funnel. The model is asked only when
 * a page shown before a merchant page led there through a tracking link; a
 * chain that passed no tracking link is no funnel and is not kept.
 */
export async function judgeCaseFunnel(params: { submissionId: bigint; chain: readonly WebsiteNavigationHop[]; pages: readonly WebsiteShownPage[] }, dependencies: WebsiteAnalysisDependencies) {
	const chain = await caseFunnelChain(params.submissionId, params.chain, params.pages);
	const { extraction, verdict } = await classifyDeceptiveFunnel({ submissionId: params.submissionId, chain }, { client: dependencies.analysisClient });
	return { chain, funnel: extraction.trackingHops.length ? { extraction, verdict } satisfies WebsiteFunnel : undefined };
}

/** What the case says of a deceptive funnel, for the narrative and the case's info. */
export function deceptiveFunnelFinding(verdict: DeceptiveFunnelFinding): string {
	return `Deceptive affiliate funnel: the chain's lure is ${DECEPTION_PHRASES[verdict.deceptionKind]}. ${verdict.lureClaim} In fact: ${verdict.reality} The lure page says "${verdict.lureQuotes[0]!.quote}"; the offer page says "${verdict.offerQuote.quote}".`;
}

/** Report a deceptive funnel's businesses: each merchant and network once per affiliate across cases. */
export async function reportCaseFunnel(params: { submissionId: bigint; chain: FunnelChain; funnel: WebsiteFunnel & { verdict: DeceptiveFunnelFinding }; reporter: ReporterMetadata }, dependencies: WebsiteAnalysisDependencies): Promise<FunnelReportOutcome[]> {
	return reportDeceptiveFunnel(
		{ submissionId: params.submissionId, chain: params.chain, extraction: params.funnel.extraction, verdict: params.funnel.verdict, reporter: params.reporter },
		dependencies.popularDomains ? { loadPopularDomains: dependencies.popularDomains } : {},
	);
}

/** What the case says about one business of its funnel: its report, the report of another case it joined, or why it was not reported. */
export function funnelOutcomeText(outcome: FunnelReportOutcome): string {
	const business = `${outcome.site} (${outcome.role === "merchant" ? "the merchant" : "affiliate network"})`;
	if (outcome.kind === "skipped") return `Deceptive affiliate funnel: ${business} is not reported, being ${outcome.reason}.`;
	if (outcome.kind === "joined") return `Deceptive affiliate funnel: affiliate ${outcome.affiliate} at ${business} is already being reported in case ${outcome.caseId.toString()}, whose report now names this case too.`;
	return `Deceptive affiliate funnel: affiliate ${outcome.affiliate} is being reported to ${business}.`;
}

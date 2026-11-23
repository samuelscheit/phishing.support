import type { ReporterMetadata } from "../../http/reporter_headers";
import { hashStableJson, sha256Hex, stableJson } from "../../util/hash";
import { normalizedEvidence, verbatimEvidenceQuote } from "../../website/analysis/classification";
import { MAX_EVIDENCE_BYTES_PER_ITEM, normalizeObservedUrl, type DecodedEvidence, type ValidatedAbuseReportRequest } from "../contracts";
import { AbuseRepository, type CreatedAbuseReport } from "../repository";
import type { FunnelChain, FunnelPage } from "./chain";
import { quoteLines, type DeceptiveFunnelFinding, type FunnelQuote } from "./classification";
import { DECEPTION_PHRASES } from "./deception";
import type { FunnelExtraction, FunnelParty } from "./extract";
import { FUNNEL_EVIDENCE_NAME, type FunnelFacts } from "./facts";
import { PLATFORM_NAMES, type FunnelPlatform } from "./platforms";
import { funnelPartyTarget } from "./target";

const MAX_OBSERVED_URLS = 100;
const MAX_SCREENSHOTS = 6;
/** The report's evidence budget (20 MiB) less room for the facts file. */
const MAX_SCREENSHOT_BYTES = 18 * 1024 * 1024;

export type FunnelReportInput = {
	submissionId: bigint;
	chain: FunnelChain;
	extraction: FunnelExtraction;
	verdict: DeceptiveFunnelFinding;
};

function normalizedUrl(value: string): string | undefined {
	try {
		return normalizeObservedUrl(value);
	} catch {
		return undefined;
	}
}

/**
 * The lure quotes that still appear verbatim on the chain's pages. The
 * verdict may be read back from storage; a report never repeats a quote the
 * evidence does not hold.
 */
function verifiedQuotes(quotes: readonly FunnelQuote[], pages: readonly FunnelPage[]): Array<FunnelQuote & { capturedAt: string }> {
	return quotes.flatMap((quote) => {
		const page = pages.find((candidate) => candidate.hopIndex === quote.hopIndex);
		if (!page || typeof verbatimEvidenceQuote(quoteLines(quote.quote), normalizedEvidence(page.text)) !== "string") return [];
		return [{ ...quote, url: normalizedUrl(quote.url) ?? quote.url, capturedAt: page.capturedAt.toISOString() }];
	});
}

/** The pages to attach: the lures, then the merchant's offer, within the evidence limits. */
function screenshots(chain: FunnelChain, extraction: FunnelExtraction): Array<{ page: FunnelPage; evidence: DecodedEvidence }> {
	const merchantHops = new Set(extraction.hopKinds.filter(({ kind }) => kind === "merchant").map(({ hopIndex }) => hopIndex));
	const lures = chain.pages.filter((page) => extraction.lurePageHops.includes(page.hopIndex));
	const offer = chain.pages.findLast((page) => merchantHops.has(page.hopIndex));
	const chosen: Array<{ page: FunnelPage; evidence: DecodedEvidence }> = [];
	let bytes = 0;
	for (const page of [...lures.slice(0, MAX_SCREENSHOTS - 1), ...(offer ? [offer] : [])]) {
		const shot = page.screenshot;
		if (!shot || shot.buffer.length > MAX_EVIDENCE_BYTES_PER_ITEM || bytes + shot.buffer.length > MAX_SCREENSHOT_BYTES) continue;
		bytes += shot.buffer.length;
		const role = merchantHops.has(page.hopIndex) ? "offer" : "lure";
		chosen.push({
			page,
			evidence: { filename: `${role}-page-${page.hopIndex}.${shot.mimeType === "image/png" ? "png" : "jpg"}`, mimeType: shot.mimeType, buffer: shot.buffer, sha256: sha256Hex(shot.buffer) },
		});
	}
	return chosen;
}

function facts(input: FunnelReportInput, party: FunnelParty, lureQuotes: FunnelFacts["deception"]["lureQuotes"], shots: ReturnType<typeof screenshots>): FunnelFacts {
	const { chain, extraction, verdict } = input;
	const kinds = new Map(extraction.hopKinds.map(({ hopIndex, kind }) => [hopIndex, kind]));
	const offerPage = verdict.offerQuote && chain.pages.find((page) => page.hopIndex === verdict.offerQuote!.hopIndex);
	const offerQuote = verdict.offerQuote && offerPage ? verifiedQuotes([verdict.offerQuote], [offerPage])[0] : undefined;
	return {
		kind: "deceptive_funnel",
		submissionId: input.submissionId.toString(),
		party: { role: party.role, site: party.site, ...(party.platform ? { platform: party.platform } : {}), ...(party.affiliateIds[0] ? { affiliateId: party.affiliateIds[0] } : {}) },
		recordedAt: chain.startedAt.toISOString(),
		deception: {
			kind: verdict.deceptionKind,
			claim: verdict.lureClaim,
			reality: verdict.reality,
			lureQuotes,
			...(offerQuote ? { offerQuote } : {}),
		},
		...(extraction.merchant
			? { merchant: { site: extraction.merchant.site, url: normalizedUrl(extraction.merchant.url) ?? extraction.merchant.url, identifiers: extraction.merchant.identifiers.map(({ kind, parameter, value }) => ({ kind, parameter, value })) } }
			: {}),
		affiliates: extraction.affiliates.map(({ id, site, platform, parameter, confidence, matchedAt }) => ({ id, site, ...(platform ? { platform } : {}), parameter, confidence, matchedAt })),
		trackers: extraction.trackingHops.map((tracker) => ({
			hopIndex: tracker.hopIndex,
			site: tracker.site,
			hostname: tracker.hostname,
			url: normalizedUrl(tracker.url) ?? tracker.url,
			platform: tracker.platform,
			role: tracker.role,
			confidence: tracker.confidence,
			signals: tracker.signals,
			identifiers: tracker.identifiers,
			...(tracker.carriedBy ? { carriedBy: tracker.carriedBy } : {}),
		})),
		chain: [...chain.hops].sort((a, b) => a.index - b.index).map((hop) => {
			const redirectTo = hop.redirectTo ? normalizedUrl(hop.redirectTo) ?? hop.redirectTo : undefined;
			return {
				index: hop.index,
				...(hop.at ? { at: hop.at.toISOString() } : {}),
				status: hop.status,
				url: normalizedUrl(hop.url) ?? hop.url,
				...(redirectTo ? { redirectTo } : {}),
				kind: kinds.get(hop.index) ?? "redirect",
			};
		}),
		carriedValues: extraction.carriedValues,
		screenshots: shots.map(({ page, evidence }) => ({ hopIndex: page.hopIndex, url: normalizedUrl(page.url) ?? page.url, filename: evidence.filename, sha256: evidence.sha256, capturedAt: page.capturedAt.toISOString() })),
	};
}

function platformName(platform: string | undefined): string | undefined {
	return platform && Object.hasOwn(PLATFORM_NAMES, platform) ? PLATFORM_NAMES[platform as FunnelPlatform] : undefined;
}

/** The report's one-line description, for the case page; the mail is drafted from the facts instead. */
function description(party: FunnelParty, verdict: DeceptiveFunnelFinding, merchantSite: string | undefined): string {
	const affiliate = party.affiliateIds[0] ? `Affiliate ${party.affiliateIds[0]}` : "An unidentified affiliate";
	const lure = DECEPTION_PHRASES[verdict.deceptionKind];
	if (party.role === "merchant") return `Deceptive affiliate funnel into ${party.site}: ${affiliate} sent visitors to the offer from ${lure}.`;
	const platform = platformName(party.platform);
	return `Deceptive affiliate funnel through ${party.site}${platform ? ` (${platform})` : ""}: ${affiliate} sent visitors from ${lure}${merchantSite ? ` to ${merchantSite}` : ""}.`;
}

/**
 * One report per business that can terminate the affiliate: the merchant
 * and each network tracking domain of the chain. Each targets the affiliate
 * at that business (`affiliate:<role>:…`); its recipient is resolved by the
 * worker (funnel/recipients.ts) and its mail drafted from the facts file it
 * carries (funnel/draft.ts). Throws when no lure quote is verbatim page text.
 */
export function buildFunnelReportRequests(input: FunnelReportInput): ValidatedAbuseReportRequest[] {
	const lureQuotes = verifiedQuotes(input.verdict.lureQuotes, input.chain.pages);
	if (!lureQuotes.length) throw new Error("A deceptive funnel report needs a lure quote that appears verbatim on a captured page.");
	const observedUrls = [...new Set([...input.chain.hops].sort((a, b) => a.index - b.index).flatMap((hop) => [hop.url, ...(hop.redirectTo ? [hop.redirectTo] : [])]).map(normalizedUrl).filter((url): url is string => Boolean(url)))].slice(0, MAX_OBSERVED_URLS);
	const shots = screenshots(input.chain, input.extraction);
	return input.extraction.parties.map((party) => {
		const target = funnelPartyTarget({ role: party.role, site: party.site, ...(party.platform ? { platform: party.platform } : {}), ...(party.affiliateIds[0] ? { affiliateId: party.affiliateIds[0] } : {}) });
		const evidenceFile = Buffer.from(stableJson(facts(input, party, lureQuotes, shots)), "utf8");
		const idempotencyKey = `funnel:${input.submissionId.toString()}:${sha256Hex(target).slice(0, 32)}`;
		const reportDescription = description(party, input.verdict, input.extraction.merchant?.site);
		return {
			originalRequest: { kind: "deceptive_funnel", submissionId: input.submissionId.toString(), target, recordedAt: input.chain.startedAt.toISOString() },
			targets: [{ ordinal: 0, originalInput: target, originalInputs: [target], normalizedTarget: target, targetType: "service_account", observedUrls }],
			allegationCategory: "fraud",
			description: reportDescription,
			observedUrls: [{ target, urls: observedUrls }],
			evidence: [
				{ filename: FUNNEL_EVIDENCE_NAME, mimeType: "application/json", buffer: evidenceFile, sha256: sha256Hex(evidenceFile) },
				...shots.map(({ evidence }) => evidence),
			],
			idempotencyKey,
			requestPayloadHash: hashStableJson({ idempotencyKey, target, reportDescription, evidenceSha256: sha256Hex(evidenceFile) }),
		};
	});
}

/** Creates the funnel's reports, each linked to the case; the worker resolves and mails them without an operator. */
export async function reportDeceptiveFunnel(input: FunnelReportInput & { reporter: ReporterMetadata }): Promise<CreatedAbuseReport[]> {
	const reports: CreatedAbuseReport[] = [];
	for (const request of buildFunnelReportRequests(input)) {
		reports.push(await AbuseRepository.createReport({ request, reporter: input.reporter, submissionId: input.submissionId }));
	}
	return reports;
}

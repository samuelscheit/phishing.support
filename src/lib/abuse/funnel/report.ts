import type { ReporterMetadata } from "../../http/reporter_headers";
import { DAY_MS } from "../../util/date_time";
import { hashStableJson, sha256Hex, stableJson } from "../../util/hash";
import { normalizedEvidence, verbatimEvidenceQuote } from "../../website/analysis/classification";
import { MAX_EVIDENCE_BYTES_PER_ITEM, normalizeObservedUrl, type DecodedEvidence, type ValidatedAbuseReportRequest } from "../contracts";
import { isPopularSite, loadPopularDomains, type PopularDomains } from "../origin/popular_domains";
import { AbuseRepository } from "../repository";
import type { FunnelChain, FunnelPage } from "./chain";
import { quoteLines, type DeceptiveFunnelFinding, type FunnelQuote } from "./classification";
import { findRecentFunnelReport, FUNNEL_REPORT_WINDOW_DAYS, funnelDedupeKey } from "./dedupe";
import { DECEPTION_PHRASES } from "./deception";
import type { FunnelExtraction, FunnelParty } from "./extract";
import { FUNNEL_EVIDENCE_NAME, type FunnelFacts } from "./facts";
import { platformLabel } from "./platforms";
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

/** One report the funnel warrants, before it is created. */
type PlannedFunnelReport = { party: FunnelParty; dedupeKey: string; request: ValidatedAbuseReportRequest };

export type FunnelReportPlan = { planned: PlannedFunnelReport[]; skipped: Array<{ site: string; role: FunnelParty["role"]; reason: string }> };

function normalizedUrl(value: string): string | undefined {
	try {
		return normalizeObservedUrl(value);
	} catch {
		return undefined;
	}
}

/**
 * The quotes that still appear verbatim on the chain's pages. The verdict
 * may be read back from storage; a report never repeats a quote the
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

function facts(
	input: FunnelReportInput,
	party: FunnelParty,
	quotes: { lureQuotes: FunnelFacts["deception"]["lureQuotes"]; offerQuote: FunnelFacts["deception"]["offerQuote"] },
	shots: ReturnType<typeof screenshots>,
): FunnelFacts {
	const { chain, extraction, verdict } = input;
	const kinds = new Map(extraction.hopKinds.map(({ hopIndex, kind }) => [hopIndex, kind]));
	const platformOf = (of: Pick<FunnelParty, "platform" | "platformConfidence">) => ({
		...(of.platform ? { platform: of.platform } : {}),
		...(of.platformConfidence ? { platformConfidence: of.platformConfidence } : {}),
	});
	return {
		kind: "deceptive_funnel",
		submissionId: input.submissionId.toString(),
		party: {
			role: party.role,
			site: party.site,
			...platformOf(party),
			...(party.affiliateIds[0] ? { affiliateId: party.affiliateIds[0] } : {}),
			...(party.creditedBy ? { creditedBy: party.creditedBy } : {}),
		},
		networks: extraction.parties.filter((other) => other.role === "network").map((network) => ({ site: network.site, ...platformOf(network), affiliateId: network.affiliateIds[0]! })),
		recordedAt: chain.startedAt.toISOString(),
		deception: { kind: verdict.deceptionKind, claim: verdict.lureClaim, reality: verdict.reality, ...quotes },
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

/** The report's one-line description, for the case page; the mail is drafted from the facts instead. */
function description(party: FunnelParty, verdict: DeceptiveFunnelFinding, merchantSite: string | undefined): string {
	const affiliate = party.affiliateIds[0]
		? `Affiliate ${party.affiliateIds[0]}`
		: `The affiliate ${party.creditedBy!.site} credits as ${party.creditedBy!.id}`;
	const lure = DECEPTION_PHRASES[verdict.deceptionKind];
	if (party.role === "merchant") return `Deceptive affiliate funnel into ${party.site}: ${affiliate} sent visitors to the offer from what we assess as ${lure}.`;
	const platform = platformLabel(party.platform, party.platformConfidence);
	return `Deceptive affiliate funnel through ${party.site}${platform ? ` (${platform})` : ""}: ${affiliate} sent visitors from what we assess as ${lure}${merchantSite ? ` to ${merchantSite}` : ""}.`;
}

/**
 * Why a party is not reported, or undefined to report it. A well-known
 * site's offer (Tranco top list) is reported only when the network passed
 * its affiliate ID on to it: a lure that ends on a big brand's page is more
 * often a redirect to the brand than the brand's own affiliate. A network
 * domain on the list is reported only when its link format left no doubt.
 */
function skipReason(party: FunnelParty, extraction: FunnelExtraction, popular: PopularDomains): string | undefined {
	const hostnames = party.hostnames.length ? party.hostnames : [party.site];
	if (!hostnames.some((hostname) => isPopularSite(hostname, popular))) return undefined;
	if (party.role === "merchant") {
		const passedOn = extraction.affiliates.some((affiliate) => affiliate.site === party.site && affiliate.matchedAt.length > 0);
		return passedOn ? undefined : "a well-known site (Tranco top list) that no network passed its affiliate ID on to";
	}
	return party.platformConfidence === "high" ? undefined : "a well-known site (Tranco top list) whose links only resemble a tracking platform's";
}

/**
 * The reports a deceptive funnel warrants: one per business that can
 * terminate the affiliate (the merchant and each affiliate network of the
 * chain). Each targets the affiliate at that business
 * (`affiliate:<role>:<platform>:<site>:<id>`, the platform only when certain
 * and the ID only when the business knows it). Its recipient is resolved by
 * the worker (funnel/recipients.ts) and its mail drafted from the facts file
 * it carries (funnel/draft.ts). Throws when no substantial lure quote or
 * the offer quote is no longer verbatim page text.
 */
export function planFunnelReports(input: FunnelReportInput & { popularDomains: PopularDomains }): FunnelReportPlan {
	const lureQuotes = verifiedQuotes(input.verdict.lureQuotes, input.chain.pages);
	const [offerQuote] = verifiedQuotes([input.verdict.offerQuote], input.chain.pages);
	if (!lureQuotes.length || !offerQuote) throw new Error("A deceptive funnel report needs its lure and offer quotes verbatim on the captured pages.");
	const observedUrls = [...new Set([...input.chain.hops].sort((a, b) => a.index - b.index).flatMap((hop) => [hop.url, ...(hop.redirectTo ? [hop.redirectTo] : [])]).map(normalizedUrl).filter((url): url is string => Boolean(url)))].slice(0, MAX_OBSERVED_URLS);
	const shots = screenshots(input.chain, input.extraction);
	const plan: FunnelReportPlan = { planned: [], skipped: [] };
	for (const party of input.extraction.parties) {
		const reason = skipReason(party, input.extraction, input.popularDomains);
		if (reason) {
			plan.skipped.push({ site: party.site, role: party.role, reason });
			continue;
		}
		const target = funnelPartyTarget({
			role: party.role,
			site: party.site,
			// A vendor is asked only about its own platform's links.
			...(party.platform && party.platformConfidence === "high" ? { platform: party.platform } : {}),
			...(party.affiliateIds[0] ? { affiliateId: party.affiliateIds[0] } : {}),
		});
		const evidenceFile = Buffer.from(stableJson(facts(input, party, { lureQuotes, offerQuote }, shots)), "utf8");
		const dedupeKey = funnelDedupeKey(party);
		const idempotencyKey = `${dedupeKey}:${input.submissionId.toString()}`;
		const reportDescription = description(party, input.verdict, input.extraction.merchant?.site);
		plan.planned.push({
			party,
			dedupeKey,
			request: {
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
			},
		});
	}
	return plan;
}

export type FunnelReportOutcome =
	| { kind: "reported"; site: string; reportId: bigint; created: boolean }
	/** Another case already reported this business and affiliate within the window; this case was linked to that report. */
	| { kind: "linked"; site: string; reportId: bigint }
	| { kind: "skipped"; site: string; reason: string };

export type FunnelReportDependencies = {
	loadPopularDomains?: () => Promise<PopularDomains>;
	now?: () => Date;
};

export const FUNNEL_CASE_LINKED_EVENT = "funnel.case_linked";

async function linkCase(reportId: bigint, submissionId: bigint, recordedAt: Date): Promise<void> {
	const events = await AbuseRepository.listEvents(reportId);
	if (events.some((event) => event.eventType === FUNNEL_CASE_LINKED_EVENT && event.data.submissionId === submissionId.toString())) return;
	await AbuseRepository.appendEvent({ reportId, eventType: FUNNEL_CASE_LINKED_EVENT, data: { submissionId: submissionId.toString(), recordedAt: recordedAt.toISOString() } });
}

/**
 * Creates the funnel's reports, each linked to the case; the worker resolves
 * and mails them without an operator. A business and affiliate another case
 * reported within FUNNEL_REPORT_WINDOW_DAYS gets no second mail: this case
 * is recorded on that report (`funnel.case_linked`) instead.
 */
export async function reportDeceptiveFunnel(input: FunnelReportInput & { reporter: ReporterMetadata }, dependencies: FunnelReportDependencies = {}): Promise<FunnelReportOutcome[]> {
	const popularDomains = await (dependencies.loadPopularDomains ?? loadPopularDomains)();
	const plan = planFunnelReports({ ...input, popularDomains });
	const since = new Date((dependencies.now ?? (() => new Date()))().getTime() - FUNNEL_REPORT_WINDOW_DAYS * DAY_MS);
	const outcomes: FunnelReportOutcome[] = plan.skipped.map(({ site, reason }) => ({ kind: "skipped", site, reason }));
	for (const { party, dedupeKey, request } of plan.planned) {
		const existing = await findRecentFunnelReport(dedupeKey, since);
		if (existing && existing.submissionId !== input.submissionId) {
			await linkCase(existing.id, input.submissionId, input.chain.startedAt);
			outcomes.push({ kind: "linked", site: party.site, reportId: existing.id });
			continue;
		}
		const report = await AbuseRepository.createReport({ request, reporter: input.reporter, submissionId: input.submissionId });
		outcomes.push({ kind: "reported", site: party.site, reportId: report.reportId, created: report.created });
	}
	return outcomes;
}

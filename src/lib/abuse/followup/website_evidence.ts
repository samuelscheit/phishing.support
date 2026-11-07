import { getDomain } from "tldts";

import { ArtifactsEntity, SubmissionsEntity } from "../../db/entities";
import { buildWebsiteEvidence } from "../../evidence/package";
import type { timestampEvidence } from "../../evidence/timestamp";
import { archiveWebsite, WebsiteCaptureFailedError, type WebsiteArchiveResult } from "../../website_archive";
import { classifyWebsiteCapture } from "../../website_ai";
import { isSameWebsite } from "../../website_site";
import type { WebsiteSiteClassification } from "../../website_types";
import type { AccountIdentifierExtractor, ProviderAccountIdentifier } from "./account_identifiers";

/**
 * Facts a provider reviewer needs about a phishing site they could not see:
 * what a fresh visit reaches now over each route, whether that page is still
 * the reported kit, our own capture made after their review, and identifiers
 * that tie the kit to an account at the provider. Everything here is measured;
 * a reply's narrative may only restate it.
 */
export type WebsiteDecisionEvidence = {
	kind: "website";
	checkedAt: string;
	/** The fresh visit: the page it ended on, over which route, and how the page answered the other routes. */
	recheck:
		| { reached: true; url: string; route?: string; cloaking?: string; finding: WebsiteSiteClassification; matchesReportedKit: boolean }
		| { reached: false; failure: string };
	/** The kit is still served right now. */
	stillServed: boolean;
	/** How the page answered visitors when the case was captured, e.g. a decoy for datacenter visitors. */
	reportedCloaking?: string;
	/** Our latest capture of the reported kit, and whether it was made after the provider's review. */
	capture?: { at: string; url: string; quote?: string; timestamped: boolean; afterReview: boolean };
	accountIdentifiers: ProviderAccountIdentifier[];
	/** A freshly stamped screenshot of what the recheck reached, when it is the kit. */
	freshScreenshot?: { filename: string; png: Buffer };
	references: string[];
};

export type WebsiteEvidenceDependencies = {
	capture?: typeof archiveWebsite;
	classify?: typeof classifyWebsiteCapture;
	timestamp?: typeof timestampEvidence;
	now?: () => Date;
};

const MIN_SHARED_WORDS = 0.6;

function words(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
}

/** Whether a fresh page is the same kit page we captured: its quote is on it, or most of its words are. */
function sameKitPage(freshText: string, stored: { text: string; quote?: string }): boolean {
	const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
	if (stored.quote && normalize(freshText).includes(normalize(stored.quote))) return true;
	const storedWords = words(stored.text);
	if (storedWords.size < 5) return false;
	const fresh = words(freshText);
	return [...storedWords].filter((word) => fresh.has(word)).length / storedWords.size >= MIN_SHARED_WORDS;
}

/** The case's captures: every page's text and HTML, the analyzed page's quote, and when the latest was made. */
async function storedCaptures(submissionId: bigint) {
	const submission = await SubmissionsEntity.get(submissionId);
	return capturesOf(submission);
}

async function capturesOf(submission: Awaited<ReturnType<typeof SubmissionsEntity.get>>) {
	const submissionId = submission?.id;
	const website = submission?.data.kind === "website" ? submission.data.website : undefined;
	if (!website || submissionId === undefined) return { pages: [] };
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const pages: Array<{ text: string; html: string; capturedAt: Date }> = [];
	for (const artifact of artifacts.filter((item) => /^website(?:-step\d+)?\.mhtml$/.test(item.name ?? ""))) {
		const blob = (await ArtifactsEntity.get(artifact.id))?.blob;
		if (!blob) continue;
		const captured = await archiveWebsite({ url: website.url, mhtmlSnapshot: Buffer.from(blob), trustMhtmlDocumentLocation: true });
		// When the page was captured: the MHTML's own date, not when the row was written.
		pages.push({ text: captured.text.toString("utf8"), html: captured.html.toString("utf8"), capturedAt: artifact.archivedAt ?? artifact.createdAt });
	}
	const latestAt = pages.reduce<Date | undefined>((latest, page) => (!latest || page.capturedAt > latest ? page.capturedAt : latest), undefined);
	return {
		website,
		pages,
		quote: website.siteAssessments?.find((assessment) => assessment.evidenceQuote && (assessment.finding === "phishing" || assessment.finding === "malware"))?.evidenceQuote,
		latest: latestAt && website.archiveUrl
			? { at: latestAt, url: website.archiveUrl, timestamped: artifacts.some((item) => item.name?.endsWith(".tsr")) }
			: undefined,
	};
}

/**
 * Pages of other confirmed cases on the reported site's registrable domain: a
 * kit spread over several hosts of one domain (docusign. and workspace.) is
 * one operator, and an identifier one of them carries ties the others to the
 * same account. Private public suffixes (vercel.app, github.io) keep unrelated
 * tenants of shared hosting apart.
 */
async function sameDomainPages(submissionId: bigint, reportedUrl: string): Promise<Array<{ host: string; html: string }>> {
	const domain = getDomain(new URL(reportedUrl).hostname, { allowPrivateDomains: true });
	if (!domain) return [];
	const pages: Array<{ host: string; html: string }> = [];
	for (const sibling of await SubmissionsEntity.listWebsitesOnDomain(domain)) {
		if (sibling.id === submissionId) continue;
		const submission = await SubmissionsEntity.get(sibling.id);
		if (submission?.status !== "reported" || submission.data.kind !== "website") continue;
		const host = new URL(submission.data.website.url).hostname;
		for (const page of (await capturesOf(submission)).pages) pages.push({ host, html: page.html });
	}
	return pages;
}

function freshScreenshotOf(archive: WebsiteArchiveResult, caseId: string, dependencies: WebsiteEvidenceDependencies) {
	if (!archive.screenshotPng) return Promise.resolve(undefined);
	return buildWebsiteEvidence({
		caseId,
		step: 0,
		submittedUrl: archive.requestedUrl,
		capturedUrl: archive.url,
		capturedAt: archive.archivedAt,
		...(archive.route ? { route: archive.route } : {}),
		navigationHops: archive.navigationHops,
		screenshotPng: archive.screenshotPng,
		mhtml: archive.mhtml,
	}, dependencies.timestamp ? { timestamp: dependencies.timestamp } : {}).then((evidence) => (evidence.stampedScreenshotPng
		? { filename: "recheck-stamped.png", png: evidence.stampedScreenshotPng }
		: undefined));
}

/**
 * Recheck a reported phishing site the way the case captured it (every route,
 * with the residential exit for cloakers), classify what it shows now, and
 * gather what ties it to the provider's account.
 */
export async function collectWebsiteDecisionEvidence(params: {
	submissionId: bigint;
	reportedUrl: string;
	/** When the provider decided; our capture after it disproves "no longer visible". */
	reviewedAt?: Date;
	caseUrl?: string;
	accountIdentifiers?: AccountIdentifierExtractor;
}, dependencies: WebsiteEvidenceDependencies = {}): Promise<WebsiteDecisionEvidence> {
	const checkedAt = (dependencies.now ?? (() => new Date()))().toISOString();
	const stored = await storedCaptures(params.submissionId);
	let recheck: WebsiteDecisionEvidence["recheck"];
	let fresh: WebsiteArchiveResult | undefined;
	try {
		// A kit that turns desktops away is rechecked as the phone the case reached it with.
		const device = stored.website?.device;
		fresh = await (dependencies.capture ?? archiveWebsite)({ url: params.reportedUrl, ...(device ? { device } : {}) });
		const finding = await (dependencies.classify ?? classifyWebsiteCapture)(fresh);
		const freshText = fresh.text.toString("utf8");
		const onReportedSite = isSameWebsite(fresh.url, params.reportedUrl);
		const matchesReportedKit = onReportedSite && stored.pages.some((page) => sameKitPage(freshText, { text: page.text, ...(stored.quote ? { quote: stored.quote } : {}) }));
		recheck = {
			reached: true,
			url: fresh.url,
			...(fresh.route ? { route: fresh.route } : {}),
			...(fresh.cloaking ? { cloaking: fresh.cloaking.detail } : {}),
			finding,
			matchesReportedKit,
		};
	} catch (error) {
		if (!(error instanceof WebsiteCaptureFailedError)) throw error;
		recheck = { reached: false, failure: error.message };
	}
	const stillServed = recheck.reached && isSameWebsite(recheck.url, params.reportedUrl)
		&& (recheck.finding.finding === "phishing" || recheck.finding.finding === "malware" || recheck.matchesReportedKit);
	const extract = params.accountIdentifiers;
	const reportedHost = new URL(params.reportedUrl).hostname;
	const accountIdentifiers: ProviderAccountIdentifier[] = [];
	if (extract) {
		// The reported host's own pages come first, so an identifier it carries is credited to it.
		const sources = [
			...stored.pages.map((page) => ({ host: reportedHost, html: page.html })),
			...(fresh ? [{ host: reportedHost, html: fresh.html.toString("utf8") }] : []),
			...await sameDomainPages(params.submissionId, params.reportedUrl),
		];
		for (const { host, html } of sources) {
			for (const identifier of extract(html)) {
				if (!accountIdentifiers.some((known) => known.kind === identifier.kind && known.value === identifier.value)) accountIdentifiers.push({ ...identifier, foundOn: host });
			}
		}
	}
	const freshScreenshot = stillServed && fresh ? await freshScreenshotOf(fresh, params.submissionId.toString(), dependencies) : undefined;
	return {
		kind: "website",
		checkedAt,
		recheck,
		stillServed,
		...(stored.website?.cloaking ? { reportedCloaking: stored.website.cloaking.detail } : {}),
		...(stored.latest ? {
			capture: {
				at: stored.latest.at.toISOString(),
				url: stored.latest.url,
				...(stored.quote ? { quote: stored.quote } : {}),
				timestamped: stored.latest.timestamped,
				afterReview: params.reviewedAt ? stored.latest.at.getTime() > params.reviewedAt.getTime() : false,
			},
		} : {}),
		accountIdentifiers,
		...(freshScreenshot ? { freshScreenshot } : {}),
		references: params.caseUrl ? [params.caseUrl] : [],
	};
}

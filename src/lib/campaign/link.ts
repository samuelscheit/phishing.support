import { AbuseRepository } from "../abuse/repository";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import { buildDossier, type Dossier, type DossierDependencies } from "../referral/dossier";
import { latestArtifactNamed, websiteCaptureFileNames } from "../website/visit/capture_files";
import { CANARY_FIELD_LABEL, type CanaryField } from "../website/types";
import { campaignBrand, guideVisitor, sameBrand, type GuidanceDependencies } from "./guidance";
import { extractIndicators, sitePageTexts, type IndicatorDependencies } from "./indicators";
import { detectLanguage } from "./language";
import { judgedSitePage, type CampaignSite, type SitePage } from "./members";
import { CampaignRepository } from "./repository";
import { describeCampaign, type CampaignFacts, type DescribeDependencies } from "./summary";
import { isBlankCapture, pageThumbnail } from "./thumbnail";

/** The preview of one captured page, stored next to its screenshot: `website-thumb.webp`, `website-step2-thumb.webp`, … */
export function thumbnailName(step: number): string {
	return websiteCaptureFileNames(step).screenshot.replace(/\.png$/, "-thumb.webp");
}

/** The stored preview of a site's judged page, and whether that page's capture is one flat colour. */
type SitePreview = { artifactId: bigint; blank: boolean };

export type LinkDependencies = IndicatorDependencies & {
	/** Store the trimmed screenshot of the site's judged page; tests skip it. */
	saveThumbnail?: (submissionId: bigint, page: SitePage) => Promise<SitePreview | undefined>;
};

/**
 * A judged page's screenshot cut to its content, stored once next to the
 * capture; a newer capture of the same page gets a new preview. Whether the
 * capture is blank is read from the capture every time, so linking a site
 * again records it for a preview stored before.
 */
async function saveJudgedPageThumbnail(submissionId: bigint, page: SitePage): Promise<SitePreview | undefined> {
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const screenshot = latestArtifactNamed(artifacts, websiteCaptureFileNames(page.step).screenshot);
	if (!screenshot) return undefined;
	const source = await ArtifactsEntity.get(BigInt(screenshot.id));
	if (!source) return undefined;
	const image = Buffer.from(source.blob);
	const blank = await isBlankCapture(image);
	const name = thumbnailName(page.step);
	const existing = latestArtifactNamed(artifacts, name);
	if (existing && BigInt(existing.id) > BigInt(screenshot.id)) return { artifactId: BigInt(existing.id), blank };
	const artifactId = await ArtifactsEntity.saveBuffer({ submissionId, name, kind: "website_thumbnail", mimeType: "image/webp", buffer: await pageThumbnail(image) });
	return { artifactId, blank };
}

/**
 * Record what one confirmed site of a case shows about its operator, put
 * the member into its campaign, and keep what the public page shows of it:
 * the language the site's pages speak and a preview of its judged page.
 * Runs again whenever the case learns more (a backend report after the
 * investigation) and gives the same result for the same evidence.
 */
export async function linkSiteMember(member: CampaignSite, dependencies: LinkDependencies = {}): Promise<bigint | undefined> {
	const submission = await (dependencies.loadSubmission ?? SubmissionsEntity.get)(member.submissionId);
	const website = submission?.data.kind === "website" ? submission.data.website : undefined;
	const pageTexts = website ? await sitePageTexts(member, website, dependencies) : [];
	const indicators = await extractIndicators(member, { ...dependencies, loadPageTexts: async () => pageTexts });
	const campaignId = await CampaignRepository.recordIndicators(member, indicators);
	if (campaignId !== undefined) {
		const siteText = pageTexts.map((page) => page.text).sort((a, b) => b.length - a.length)[0] ?? "";
		const page = website && judgedSitePage(website, member.site);
		const preview = page ? await (dependencies.saveThumbnail ?? saveJudgedPageThumbnail)(member.submissionId, page).catch(() => undefined) : undefined;
		await CampaignRepository.saveSiteFacts(member, { language: detectLanguage(siteText) ?? null, thumbnailArtifactId: preview?.artifactId ?? null, blankCapture: preview?.blank ?? false });
	}
	return campaignId;
}

/** The analysis each member's site report was filed with, newest members first. */
async function siteAnalyses(reportIds: readonly string[]): Promise<string[]> {
	const analyses: string[] = [];
	for (const id of [...new Set(reportIds)].reverse()) {
		const report = await AbuseRepository.getReport(BigInt(id));
		if (report?.description) analyses.push(report.description);
	}
	return analyses;
}

/** What a campaign's heading may say, from its dossier and its sites' languages; without the analyses. */
export function factsFromDossier(dossier: Dossier, languages: ReadonlyArray<string | null | undefined>): CampaignFacts {
	// A page fingerprint ties the sites by what they show, not by code they run.
	const kinds = new Set(dossier.indicators.filter((indicator) => indicator.links && indicator.sites.length > 1)
		.map((indicator) => (["page_document", "page_structure"].includes(String(indicator.evidence.fileKind)) ? "page" : indicator.kind)));
	return {
		siteCount: dossier.sites.length,
		firstSeenAt: dossier.firstSeenAt,
		lastSeenAt: dossier.lastSeenAt,
		hosts: dossier.sites.map((site) => site.host),
		impersonates: dossier.impersonates,
		dataRequested: dossier.requestedFields.map((field) => CANARY_FIELD_LABEL[field as CanaryField] ?? field),
		languages: [...new Set(languages.filter((language): language is string => Boolean(language)))],
		providers: [...new Set(dossier.sites.flatMap((site) => site.reports.map((report) => report.provider)))],
		links: [
			...(kinds.has("kit_fingerprint") ? ["same_code" as const] : []),
			...(kinds.has("page") ? ["same_page" as const] : []),
			...(kinds.has("operator_server") ? ["same_backend" as const] : []),
			...(kinds.has("delivery_command") ? ["same_delivery" as const] : []),
			...(kinds.has("payment_receiver") ? ["same_payment_account" as const] : []),
		],
		analyses: [],
	};
}

/** The stored facts a campaign's public heading and visitor guidance are written from, with a few sites' analyses. */
async function campaignFacts(dossier: Dossier): Promise<CampaignFacts> {
	const facts = await CampaignRepository.listSiteFacts(dossier.sites.map((site) => ({ submissionId: BigInt(site.submissionId), reportId: BigInt(site.reportId) })));
	return {
		...factsFromDossier(dossier, facts.map((fact) => fact.language)),
		analyses: await siteAnalyses(dossier.sites.map((site) => site.reportId)),
	};
}

/**
 * Write a campaign's public title and summary when its sites changed since
 * they were written, and its visitor guidance then too, or when it has none
 * for the brand its sites impersonate now. A campaign that absorbed another
 * is described anew; an emptied one is left alone. Guidance the model could
 * not give is not stored, so the next run asks again. Returns whether
 * anything was written.
 */
export async function describeCampaignIfChanged(campaignId: bigint, dependencies: DescribeDependencies & GuidanceDependencies & { dossier?: DossierDependencies } = {}): Promise<boolean> {
	const current = await CampaignRepository.currentCampaignId(campaignId);
	if (current === undefined) return false;
	const campaign = await CampaignRepository.getCampaign(current);
	const siteCount = await CampaignRepository.memberCount(current);
	if (!campaign || siteCount === 0) return false;
	const describe = campaign.summarySiteCount !== siteCount;
	const dossier = await buildDossier(current, dependencies.dossier);
	if (!dossier.sites.length) return false;
	const brand = campaignBrand(dossier);
	const guide = brand !== undefined && (describe || !sameBrand(campaign.visitorGuidance?.brand, brand));
	if (!describe && !guide) return false;
	const facts = await campaignFacts(dossier);
	let written = false;
	if (describe) {
		const description = await describeCampaign(facts, dependencies);
		await CampaignRepository.saveDescription(current, { title: description.title, summary: description.summary, siteCount: facts.siteCount });
		written = true;
	}
	if (guide) {
		const { guidance, generated } = await guideVisitor({ brand, facts }, dependencies);
		if (generated) {
			await CampaignRepository.saveVisitorGuidance(current, guidance);
			written = true;
		}
	}
	return written;
}

import { AbuseRepository } from "../abuse/repository";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import { buildDossier, type Dossier, type DossierDependencies } from "../referral/dossier";
import { analyzedPage, latestArtifactNamed, websiteCaptureFileNames } from "../website/visit/capture_files";
import { CANARY_FIELD_LABEL, type CanaryField } from "../website/types";
import { campaignBrand, guideVisitor, sameBrand, type GuidanceDependencies } from "./guidance";
import { extractIndicators, loadCapturedPageTexts, type IndicatorDependencies } from "./indicators";
import { detectLanguage } from "./language";
import { CampaignRepository } from "./repository";
import { describeCampaign, type CampaignFacts, type DescribeDependencies } from "./summary";
import { isBlankCapture, pageThumbnail } from "./thumbnail";

const THUMBNAIL_NAME = "website-thumb.webp";

/** The stored preview of a site's analyzed page, and whether that page's capture is one flat colour. */
type SitePreview = { artifactId: bigint; blank: boolean };

export type LinkDependencies = IndicatorDependencies & {
	/** Store the trimmed screenshot of the analyzed page; tests skip it. */
	saveThumbnail?: (submissionId: bigint) => Promise<SitePreview | undefined>;
};

/**
 * The analyzed page's screenshot cut to its content, stored once next to
 * the capture; a newer capture of the same case gets a new preview. Whether
 * the capture is blank is read from the capture every time, so linking a
 * site again records it for a preview stored before.
 */
async function saveAnalyzedPageThumbnail(submissionId: bigint): Promise<SitePreview | undefined> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (submission?.data.kind !== "website") return undefined;
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const screenshot = latestArtifactNamed(artifacts, websiteCaptureFileNames(analyzedPage(submission.data.website)?.step ?? 0).screenshot)
		?? latestArtifactNamed(artifacts, websiteCaptureFileNames(0).screenshot);
	if (!screenshot) return undefined;
	const source = await ArtifactsEntity.get(BigInt(screenshot.id));
	if (!source) return undefined;
	const image = Buffer.from(source.blob);
	const blank = await isBlankCapture(image);
	const existing = latestArtifactNamed(artifacts, THUMBNAIL_NAME);
	if (existing && BigInt(existing.id) > BigInt(screenshot.id)) return { artifactId: BigInt(existing.id), blank };
	const artifactId = await ArtifactsEntity.saveBuffer({ submissionId, name: THUMBNAIL_NAME, kind: "website_thumbnail", mimeType: "image/webp", buffer: await pageThumbnail(image) });
	return { artifactId, blank };
}

/**
 * Record what one confirmed site shows about its operator, put it into its
 * campaign, and keep what the public page shows of it: the language its page
 * speaks and a preview cut to the page. Runs again whenever the case learns
 * more (a backend report after the investigation) and gives the same result
 * for the same evidence.
 */
export async function linkSubmissionToCampaign(submissionId: bigint, dependencies: LinkDependencies = {}): Promise<bigint | undefined> {
	const pageTexts = await (dependencies.loadPageTexts ?? loadCapturedPageTexts)(submissionId);
	const indicators = await extractIndicators(submissionId, { ...dependencies, loadPageTexts: async () => pageTexts });
	const campaignId = await CampaignRepository.recordIndicators(submissionId, indicators);
	if (campaignId !== undefined) {
		const analyzedText = pageTexts.map((page) => page.text).sort((a, b) => b.length - a.length)[0] ?? "";
		const preview = await (dependencies.saveThumbnail ?? saveAnalyzedPageThumbnail)(submissionId).catch(() => undefined);
		await CampaignRepository.saveSiteFacts(submissionId, { language: detectLanguage(analyzedText) ?? null, thumbnailArtifactId: preview?.artifactId ?? null, blankCapture: preview?.blank ?? false });
	}
	return campaignId;
}

/** The analysis each site's report was filed with, newest sites first. */
async function siteAnalyses(submissionIds: readonly string[]): Promise<string[]> {
	const analyses: string[] = [];
	for (const id of [...submissionIds].reverse()) {
		const primary = (await AbuseRepository.listReportsForSubmission(BigInt(id))).find((report) => !report.idempotencyKey);
		if (primary?.description) analyses.push(primary.description);
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
	const facts = await CampaignRepository.listSiteFacts(dossier.sites.map((site) => BigInt(site.submissionId)));
	return {
		...factsFromDossier(dossier, facts.map((fact) => fact.language)),
		analyses: await siteAnalyses(dossier.sites.map((site) => site.submissionId)),
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

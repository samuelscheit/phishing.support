import { AbuseRepository } from "../abuse/repository";
import { ArtifactsEntity, SubmissionsEntity } from "../db/entities";
import { buildDossier, type Dossier, type DossierDependencies } from "../referral/dossier";
import { analyzedCaptureStep, latestArtifactNamed, websiteCaptureFileNames } from "../website_capture_files";
import { CANARY_FIELD_LABEL, type CanaryField } from "../website_types";
import { extractIndicators, loadCapturedPageTexts, type IndicatorDependencies } from "./indicators";
import { detectLanguage } from "./language";
import { CampaignRepository } from "./repository";
import { describeCampaign, type CampaignFacts, type DescribeDependencies } from "./summary";
import { pageThumbnail } from "./thumbnail";

const THUMBNAIL_NAME = "website-thumb.webp";

export type LinkDependencies = IndicatorDependencies & {
	/** Store the trimmed screenshot of the analyzed page; tests skip it. */
	saveThumbnail?: (submissionId: bigint) => Promise<bigint | undefined>;
};

/**
 * The analyzed page's screenshot cut to its content, stored once next to
 * the capture. A newer capture of the same case gets a new preview.
 */
async function saveAnalyzedPageThumbnail(submissionId: bigint): Promise<bigint | undefined> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (submission?.data.kind !== "website") return undefined;
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const screenshot = latestArtifactNamed(artifacts, websiteCaptureFileNames(analyzedCaptureStep(submission.data.website.navigationHops)).screenshot)
		?? latestArtifactNamed(artifacts, websiteCaptureFileNames(0).screenshot);
	if (!screenshot) return undefined;
	const existing = latestArtifactNamed(artifacts, THUMBNAIL_NAME);
	if (existing && BigInt(existing.id) > BigInt(screenshot.id)) return BigInt(existing.id);
	const source = await ArtifactsEntity.get(BigInt(screenshot.id));
	if (!source) return undefined;
	return ArtifactsEntity.saveBuffer({ submissionId, name: THUMBNAIL_NAME, kind: "website_thumbnail", mimeType: "image/webp", buffer: await pageThumbnail(Buffer.from(source.blob)) });
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
		const thumbnailArtifactId = await (dependencies.saveThumbnail ?? saveAnalyzedPageThumbnail)(submissionId).catch(() => undefined);
		await CampaignRepository.saveSiteFacts(submissionId, { language: detectLanguage(analyzedText) ?? null, thumbnailArtifactId: thumbnailArtifactId ?? null });
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
			...(kinds.has("exfiltration_backend") ? ["same_backend" as const] : []),
			...(kinds.has("payment_receiver") ? ["same_payment_account" as const] : []),
		],
		analyses: [],
	};
}

/** The stored facts a campaign's public heading is written from, with a few sites' analyses. */
export async function campaignFacts(campaignId: bigint, dependencies: { dossier?: DossierDependencies } = {}): Promise<CampaignFacts | undefined> {
	const dossier = await buildDossier(campaignId, dependencies.dossier);
	if (!dossier.sites.length) return undefined;
	const facts = await CampaignRepository.listSiteFacts(dossier.sites.map((site) => BigInt(site.submissionId)));
	return {
		...factsFromDossier(dossier, facts.map((fact) => fact.language)),
		analyses: await siteAnalyses(dossier.sites.map((site) => site.submissionId)),
	};
}

/**
 * Write a campaign's public title and summary when its sites changed since
 * they were written. A campaign that absorbed another is described anew;
 * an emptied one is left alone.
 */
export async function describeCampaignIfChanged(campaignId: bigint, dependencies: DescribeDependencies & { dossier?: DossierDependencies } = {}): Promise<boolean> {
	const current = await CampaignRepository.currentCampaignId(campaignId);
	if (current === undefined) return false;
	const campaign = await CampaignRepository.getCampaign(current);
	const siteCount = await CampaignRepository.memberCount(current);
	if (!campaign || siteCount === 0 || campaign.summarySiteCount === siteCount) return false;
	const facts = await campaignFacts(current, dependencies);
	if (!facts) return false;
	const description = await describeCampaign(facts, dependencies);
	await CampaignRepository.saveDescription(current, { title: description.title, summary: description.summary, siteCount: facts.siteCount });
	return true;
}

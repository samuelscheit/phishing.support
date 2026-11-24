import { fabricBrowserConfigFromEnvironment } from "../../browser/fabric";
import { buildWebsiteEvidence, type WebsiteEvidencePackage } from "../../evidence/package";
import { buildVisitEvidence } from "../../evidence/visit";
import { WEBSITE_DEVICE_LABEL, type WebsiteDevice } from "../types";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import { analyzedCaptureStep, latestArtifactNamed, websiteCaptureFileNames, type CapturePage } from "../visit/capture_files";
import { discoverExfiltrationBackends } from "../../exfiltration/analysis";
import type { ExfiltrationCanaries } from "../../exfiltration/types";
import type { VisitPage } from "../../site_visit/evidence";
import type { SiteVisitRecording } from "../../site_visit/visit";
import type { WebsiteAnalysisDependencies, WebsiteCapture } from "./analysis_types";

/** What a capture contributes to the submission record. */
export function capturedWebsiteData(archive: WebsiteCapture) {
	return {
		archiveUrl: archive.url,
		...(archive.cloaking ? { cloaking: archive.cloaking } : {}),
		...(archive.verificationGate ? { verificationGate: archive.verificationGate } : {}),
		...(archive.providerWarning ? { providerWarning: archive.providerWarning } : {}),
		...(archive.kitResources?.length ? { kitResources: archive.kitResources } : {}),
		...(archive.hiddenFrames?.length ? { hiddenFrames: archive.hiddenFrames } : {}),
		...(archive.offeredDownload ? { offeredDownload: archive.offeredDownload } : {}),
		...(archive.device ? { device: archive.device } : {}),
	};
}

/** The evidence package for a capture on one route of the case: stamped screenshot, manifest, and its timestamp. */
export async function websiteEvidence(
	submissionId: bigint,
	submittedUrl: string,
	archive: WebsiteCapture,
	dependencies: WebsiteAnalysisDependencies,
	route: number,
): Promise<WebsiteEvidencePackage> {
	return buildWebsiteEvidence({
		caseId: submissionId.toString(),
		page: { route, step: analyzedCaptureStep(archive.navigationHops) },
		submittedUrl,
		capturedUrl: archive.url,
		capturedAt: archive.archivedAt,
		...(archive.route ? { route: archive.route } : {}),
		navigationHops: archive.navigationHops,
		...(archive.hopBodies?.length ? { hopBodies: archive.hopBodies } : {}),
		...(archive.screenshotPng ? { screenshotPng: archive.screenshotPng } : {}),
		mhtml: archive.mhtml,
	}, dependencies.timestampEvidence ? { timestamp: dependencies.timestampEvidence } : {});
}

/**
 * Keep the visit as timestamped evidence next to the case's captures: the
 * synthetic values, what the agent typed where, the pages shown, and every
 * request that carried a value with the server's answer.
 */
export async function saveVisitEvidence(params: {
	submissionId: bigint;
	/** The route of the case the visit walked; it names the files. */
	route: number;
	url: string;
	device?: WebsiteDevice;
	recording: SiteVisitRecording<WebsiteCapture>;
	pages: ReadonlyArray<VisitPage<WebsiteCapture>>;
	canaries: ExfiltrationCanaries;
	dependencies: WebsiteAnalysisDependencies;
}): Promise<void> {
	const { recording } = params;
	const endedAt = new Date();
	// The policy the visit's browser was leased with: the configured ref or Fabric's built-in default.
	const egressPolicy = fabricBrowserConfigFromEnvironment()?.egressPolicyRefs.phishing;
	const evidence = await buildVisitEvidence({
		caseId: params.submissionId.toString(),
		route: params.route,
		submittedUrl: params.url,
		startedAt: recording.startedAt,
		endedAt,
		environment: {
			device: WEBSITE_DEVICE_LABEL[params.device ?? "desktop"],
			...(egressPolicy ? { egress: `Browser Fabric egress policy ${egressPolicy}` } : {}),
			agent: "Browser Fabric task agent",
			agentOutcome: recording.agent.outcome,
		},
		syntheticValues: params.canaries,
		actions: recording.agent.actions,
		pages: params.pages.map((page) => ({ url: page.archive.url, shownFrom: page.shownFrom, ...(page.shownUntil ? { shownUntil: page.shownUntil } : {}) })),
		requests: recording.requests,
		backends: discoverExfiltrationBackends({ requests: recording.requests, canaries: params.canaries, pageUrl: params.url }),
	}, params.dependencies.timestampEvidence ? { timestamp: params.dependencies.timestampEvidence } : {});
	for (const file of evidence.files) {
		await ArtifactsEntity.saveBuffer({ submissionId: params.submissionId, name: file.name, kind: "website_evidence", mimeType: file.mimeType, archivedAt: endedAt, buffer: file.bytes });
	}
}

/**
 * The captured pages' screenshots for providers, stamped with their URL and
 * capture time where that worked: the analyzed page first, then the pages of
 * its route that led to it.
 */
export async function capturedPageScreenshots(submissionId: bigint, analyzed: CapturePage): Promise<Array<{ filename: string; png: Buffer }>> {
	return pageScreenshots(submissionId, [analyzed, ...Array.from({ length: analyzed.step }, (_, step) => ({ route: analyzed.route, step }))]);
}

/** The stamped screenshot of each page, else its plain one; a page without one is left out. */
export async function pageScreenshots(submissionId: bigint, pages: readonly CapturePage[]): Promise<Array<{ page: CapturePage; filename: string; png: Buffer }>> {
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const screenshots: Array<{ page: CapturePage; filename: string; png: Buffer }> = [];
	for (const page of pages) {
		const names = websiteCaptureFileNames(page);
		const stored = latestArtifactNamed(artifacts, names.stampedScreenshot) ?? latestArtifactNamed(artifacts, names.screenshot);
		const png = stored ? (await ArtifactsEntity.get(stored.id))?.blob : undefined;
		if (png?.byteLength) screenshots.push({ page, filename: names.screenshot, png: Buffer.from(png) });
	}
	return screenshots;
}

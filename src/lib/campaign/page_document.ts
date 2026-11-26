import { ArtifactsEntity } from "../db/entities/artifacts";
import { latestArtifactNamed, websiteCaptureFileNames } from "../website/visit/capture_files";
import { pageFingerprints, type PageFingerprints } from "../website/page_fingerprint";
import type { SitePage } from "./members";

/** The fingerprints of a site's judged page, the page its report is about. */
export async function loadPageFingerprints(submissionId: bigint, page: SitePage): Promise<PageFingerprints> {
	const meta = latestArtifactNamed(await ArtifactsEntity.listForSubmission(submissionId), websiteCaptureFileNames(page).mhtml);
	const artifact = meta ? await ArtifactsEntity.get(BigInt(meta.id)) : undefined;
	return artifact ? pageFingerprints(Buffer.from(artifact.blob), page.url) : {};
}

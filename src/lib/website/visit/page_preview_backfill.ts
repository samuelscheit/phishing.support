import { eq } from "drizzle-orm";

import { ArtifactsEntity } from "../../db/entities/artifacts";
import { getDb } from "../../db/index";
import { artifacts } from "../../db/schema";
import { errorSummary } from "../../util/error_text";
import { screenshotCapturePage } from "./capture_files";

/** Screenshots between two progress lines. */
const PROGRESS_EVERY = 100;

export type PreviewBackfillResult = { pages: number; created: number; skipped: number; failed: number };

/**
 * Make the preview of every captured page stored before captures made one
 * (`ArtifactsEntity.ensurePagePreview`): one pass over the stored
 * screenshots, page by page. A page whose preview is newer than its
 * screenshot keeps it, so running it again creates nothing.
 */
export async function backfillPagePreviews(log: (line: string) => void = console.log): Promise<PreviewBackfillResult> {
	const db = await getDb();
	const screenshots = await db.selectDistinct({ submissionId: artifacts.submissionId, name: artifacts.name }).from(artifacts).where(eq(artifacts.kind, "website_png"));
	const result: PreviewBackfillResult = { pages: screenshots.length, created: 0, skipped: 0, failed: 0 };
	for (const [index, { submissionId, name }] of screenshots.entries()) {
		const page = name ? screenshotCapturePage(name) : undefined;
		if (submissionId === null || !page) {
			result.skipped++;
			log(`Skipped screenshot ${name ?? "(unnamed)"} of case ${submissionId ?? "(none)"}: not a page capture`);
		} else {
			try {
				if ((await ArtifactsEntity.ensurePagePreview(submissionId, page))?.created) result.created++;
			} catch (error) {
				result.failed++;
				log(`Failed ${name} of case ${submissionId}: ${errorSummary(error)}`);
			}
		}
		if ((index + 1) % PROGRESS_EVERY === 0) log(`${index + 1}/${screenshots.length} pages, ${result.created} previews made`);
	}
	log(`Done: ${JSON.stringify(result)}`);
	return result;
}

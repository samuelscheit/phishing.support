import { eq } from "drizzle-orm";
import { getDb } from "../index";
import { readBlob, writeBlob } from "../blobs";
import { artifacts, type Artifact } from "../schema";
import { generateId } from "../ids";
import { websiteEvidenceFiles, type WebsiteEvidencePackage } from "../../evidence/package";
import { chainHopBodyFileName, latestArtifactNamed, websiteCaptureFileNames, type CapturePage } from "../../website/visit/capture_files";
import { pagePreview } from "../../website/visit/page_preview";
import { errorSummary } from "../../util/error_text";
import type { HopBody } from "../../website/visit/tab_recording";

export class ArtifactsEntity {
    static async saveBuffer(params: {
        submissionId?: bigint;
        name?: string;
        kind: string;
        mimeType?: string;
        archivedAt?: Date;
        buffer: Buffer;
    }) {
        const db = await getDb();
        const id = generateId();
        // The bytes are stored before the row that names them.
        const { sha256, size } = writeBlob(params.buffer);
		const [row] = await db
			.insert(artifacts)
            .values([
                {
                    id,
                    submissionId: params.submissionId,
                    name: params.name,
                    kind: params.kind,
                    archivedAt: params.archivedAt,
                    mimeType: params.mimeType,
                    sha256,
                    size,
                    createdAt: new Date(),
                },
            ])
			.returning({ id: artifacts.id });

        return row!.id;
    }

    static async listForSubmission(submissionId: bigint) {
        const db = await getDb();
        return await db
            .select({
                id: artifacts.id,
                name: artifacts.name,
                kind: artifacts.kind,
                mimeType: artifacts.mimeType,
                size: artifacts.size,
                createdAt: artifacts.createdAt,
                archivedAt: artifacts.archivedAt,
                sha256: artifacts.sha256,
            })
            .from(artifacts)
            .where(eq(artifacts.submissionId, submissionId));
    }

    /** The artifact with its bytes. */
    static async get(id: bigint): Promise<Artifact | undefined> {
        const db = await getDb();
        const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
        return row ? { ...row, blob: readBlob(row.sha256) } : undefined;
    }

    /**
     * The preview of a captured page (`websiteCaptureFileNames(page).preview`),
     * stored next to its screenshot: the stored one while it is newer than the
     * page's newest screenshot, else cut from that screenshot now (a retry
     * capturing the page again gets a new one). Nothing when the page has no
     * screenshot. `created` says whether this call stored it.
     */
    static async ensurePagePreview(submissionId: bigint, page: CapturePage): Promise<{ previewId: bigint; screenshotId: bigint; created: boolean } | undefined> {
        const names = websiteCaptureFileNames(page);
        const stored = await this.listForSubmission(submissionId);
        const screenshot = latestArtifactNamed(stored, names.screenshot);
        if (!screenshot) return undefined;
        const existing = latestArtifactNamed(stored, names.preview);
        if (existing && existing.id > screenshot.id) return { previewId: existing.id, screenshotId: screenshot.id, created: false };
        const source = await this.get(screenshot.id);
        if (!source) return undefined;
        const previewId = await this.saveBuffer({
            submissionId,
            name: names.preview,
            kind: "website_thumbnail",
            mimeType: "image/webp",
            archivedAt: source.archivedAt ?? undefined,
            buffer: await pagePreview(Buffer.from(source.blob)),
        });
        return { previewId, screenshotId: screenshot.id, created: true };
    }

    /**
     * Store a capture with its evidence package: the raw screenshot and MHTML
     * exactly as captured, the raw body of every document answer that led to
     * the page, the screenshot with its address bar, the manifest naming every
     * file by SHA-256, and the RFC 3161 token for that manifest. The page's
     * preview is stored next to the screenshot; it only serves display, so a
     * screenshot it cannot be cut from leaves the capture whole.
     */
    static async saveWebsiteArtifacts({
        archive,
        submissionId,
        evidence,
    }: {
        submissionId: bigint;
        archive: {
            archivedAt: Date;
            screenshotPng?: Buffer;
            mhtml: Buffer;
            hopBodies?: readonly HopBody[];
        };
        /** Names the files after the page of the case's flow it covers. */
        evidence: WebsiteEvidencePackage;
    }) {
        const names = websiteCaptureFileNames(evidence.page);
        const mhtmlId = await this.saveBuffer({
            submissionId,
            name: names.mhtml,
            kind: "website_mhtml",
            mimeType: "text/mhtml",
            archivedAt: archive.archivedAt,
            buffer: archive.mhtml,
        });
        const screenshotId = archive.screenshotPng?.byteLength
            ? await this.saveBuffer({
                submissionId,
                name: names.screenshot,
                kind: "website_png",
                mimeType: "image/png",
                archivedAt: archive.archivedAt,
                buffer: archive.screenshotPng,
            })
            : undefined;
        if (screenshotId !== undefined) {
            await this.ensurePagePreview(submissionId, evidence.page).catch((error: unknown) => {
                console.warn(`The preview of case ${submissionId}'s ${names.screenshot} could not be made: ${errorSummary(error)}`);
            });
        }
        // A chain body is the kit's own markup and script exactly as the network
        // delivered it: stored as opaque bytes, so nothing ever serves it as a page
        // of ours. The type it was served as stays on its navigation hop
        // (`contentType` of the hop at `hopIndex`).
        for (const { hopIndex, body } of archive.hopBodies ?? []) {
            await this.saveBuffer({
                submissionId,
                name: chainHopBodyFileName(evidence.page.route, hopIndex),
                kind: "website_hop_body",
                mimeType: "application/octet-stream",
                archivedAt: archive.archivedAt,
                buffer: body,
            });
        }
        for (const file of websiteEvidenceFiles(evidence)) {
            await this.saveBuffer({
                submissionId,
                name: file.name,
                kind: "website_evidence",
                mimeType: file.mimeType,
                archivedAt: archive.archivedAt,
                buffer: file.bytes,
            });
        }

        return {
            screenshotId,
            mhtmlId,
        };
    }
}

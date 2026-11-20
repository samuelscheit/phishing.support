import { and, eq } from "drizzle-orm";
import { getDb } from "../index";
import { artifacts } from "../schema";
import { generateId } from "../ids";
import { websiteEvidenceFiles, type WebsiteEvidencePackage } from "../../evidence/package";
import { websiteCaptureFileNames } from "../../website/capture_files";
import { sha256Hex } from "../../util/hash";

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
                    sha256: sha256Hex(params.buffer),
                    size: params.buffer.byteLength,
                    blob: params.buffer,
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

    static async get(id: bigint) {
        const db = await getDb();
        const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
        return row;
    }

    /**
     * Store a capture with its evidence package: the raw screenshot and MHTML
     * exactly as captured, the screenshot with its address bar, the manifest
     * naming every file by SHA-256, and the RFC 3161 token for that manifest.
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
        };
        /** Names the files after the page of the case's flow it covers. */
        evidence: WebsiteEvidencePackage;
    }) {
        const names = websiteCaptureFileNames(evidence.step);
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

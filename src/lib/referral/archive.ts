import { Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js";
import sanitizeFilename from "sanitize-filename";

import { AbuseRepository } from "../abuse/repository";
import { ArtifactsEntity } from "../db/entities/artifacts";
import type { Dossier } from "./dossier";
import { countryAnnexes } from "./annex";
import { correspondenceFileName, correspondenceIndexText, dossierText, indicatorsCsv, siteAnalysisText, sitesCsv } from "./archive_text";

export type DossierArchiveDependencies = {
	loadArtifact?: (artifactId: bigint) => Promise<{ blob: Uint8Array | Buffer } | undefined>;
	/** A stored mail of a takedown report, by report and artifact id. */
	loadMail?: (reportId: bigint, artifactId: bigint) => Promise<{ blob: Uint8Array | Buffer } | undefined>;
};

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/** The small files every referral mail carries and every archive starts with. */
export function dossierAttachments(dossier: Dossier): Array<{ name: string; mimeType: string; content: Buffer }> {
	return [
		{ name: "sites.csv", mimeType: "text/csv", content: Buffer.from(sitesCsv(dossier.sites), "utf8") },
		{ name: "indicators.csv", mimeType: "text/csv", content: Buffer.from(indicatorsCsv(dossier.indicators), "utf8") },
	];
}

/** Formats that are compressed already: deflating them costs CPU time and saves nothing. */
const COMPRESSED = /\.(png|jpe?g|gif|webp|avif|gz|zip)$/i;

/**
 * The whole campaign as one ZIP, streamed while it is written: the dossier as
 * text, CSV and JSON, and each site's evidence files byte for byte, so their
 * SHA-256 match the manifests and the RFC 3161 tokens. A file whose stored
 * bytes no longer match its recorded hash is left out and named in the
 * archive instead of being shipped. Each file is loaded only when its entry is
 * written and the stream's backpressure paces the writing, so a campaign of
 * hundreds of megabytes starts downloading at once and is never held in memory.
 */
export function dossierArchive(dossier: Dossier, dependencies: DossierArchiveDependencies = {}): ReadableStream<Uint8Array> {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	writeDossierArchive(new ZipWriter(writable), dossier, dependencies).catch(async (error: unknown) => {
		console.error(`Dossier archive of campaign ${dossier.campaignId} failed:`, error);
		// The download ends as failed instead of as a truncated file that looks complete.
		await writable.abort(error).catch(() => undefined);
	});
	return readable;
}

async function writeDossierArchive(writer: ZipWriter<unknown>, dossier: Dossier, dependencies: DossierArchiveDependencies): Promise<void> {
	const loadArtifact = dependencies.loadArtifact ?? ArtifactsEntity.get;
	const loadMail = dependencies.loadMail ?? AbuseRepository.getArtifact;
	const add = (name: string, content: Uint8Array) => writer.add(name, new Uint8ArrayReader(content), COMPRESSED.test(name) ? { level: 0 } : {});
	await add("dossier.txt", Buffer.from(dossierText(dossier), "utf8"));
	for (const attachment of dossierAttachments(dossier)) await add(attachment.name, attachment.content);
	await add("dossier.json", Buffer.from(JSON.stringify(dossier, null, 2), "utf8"));
	for (const annex of countryAnnexes(dossier)) await add(annex.fileName, Buffer.from(annex.text, "utf8"));
	const missing: string[] = [];
	for (const [index, site] of dossier.sites.entries()) {
		const folder = `evidence/${String(index + 1).padStart(3, "0")}-${sanitizeFilename(site.host) || site.submissionId}`;
		await add(`${folder}/analysis.txt`, Buffer.from(siteAnalysisText(site), "utf8"));
		const used = new Set<string>();
		// A case captured again keeps every capture: a repeated name gets its artifact id, the newest keeps the plain name.
		const newestFirst = [...site.evidence].sort((a, b) => (BigInt(b.artifactId) > BigInt(a.artifactId) ? 1 : -1));
		for (const file of newestFirst) {
			const artifact = await loadArtifact(BigInt(file.artifactId));
			const bytes = artifact ? Buffer.from(artifact.blob) : undefined;
			const hash = bytes ? sha256(bytes) : undefined;
			if (!bytes || hash !== file.sha256) {
				missing.push(`${folder}/${file.name}: ${bytes ? "the stored bytes do not match the recorded SHA-256" : "no longer stored"}`);
				continue;
			}
			const name = sanitizeFilename(file.name) || file.artifactId;
			const unique = used.has(name) ? name.replace(/(\.[^.]*)?$/, (extension) => `.${file.artifactId}${extension}`) : name;
			used.add(unique);
			await add(`${folder}/${unique}`, bytes);
		}
		// The mails with the providers as they were sent and received: the original message where it is stored, its text otherwise.
		if (site.correspondence.length) {
			await add(`${folder}/correspondence/index.txt`, Buffer.from(correspondenceIndexText(site), "utf8"));
			for (const [position, mail] of site.correspondence.entries()) {
				const name = `${folder}/correspondence/${correspondenceFileName(mail, position)}`;
				if (!mail.raw) {
					await add(name, Buffer.from(mail.text ?? "", "utf8"));
					continue;
				}
				const stored = await loadMail(BigInt(mail.reportId), BigInt(mail.raw.artifactId));
				const bytes = stored ? Buffer.from(stored.blob) : undefined;
				if (!bytes || sha256(bytes) !== mail.raw.sha256) {
					missing.push(`${name}: ${bytes ? "the stored bytes do not match the recorded SHA-256" : "no longer stored"}`);
					continue;
				}
				await add(name, bytes);
			}
		}
	}
	if (missing.length) await add("missing-files.txt", Buffer.from(`${missing.join("\n")}\n`, "utf8"));
	await writer.close();
}

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import sanitizeFilename from "sanitize-filename";

import { ArtifactsEntity } from "../db/entities";
import type { Dossier } from "./dossier";
import { dossierText, indicatorsCsv, sitesCsv } from "./render";

export type DossierArchiveDependencies = {
	loadArtifact?: (artifactId: bigint) => Promise<{ blob: Uint8Array | Buffer } | undefined>;
};

/** The small files every referral mail carries and every archive starts with. */
export function dossierAttachments(dossier: Dossier): Array<{ name: string; mimeType: string; content: Buffer }> {
	return [
		{ name: "Websites.csv", mimeType: "text/csv", content: Buffer.from(sitesCsv(dossier.sites), "utf8") },
		{ name: "Merkmale.csv", mimeType: "text/csv", content: Buffer.from(indicatorsCsv(dossier.indicators), "utf8") },
	];
}

/**
 * The whole campaign as one ZIP: the dossier as text, CSV and JSON, and each
 * site's evidence files byte for byte, so their SHA-256 match the manifests
 * and the RFC 3161 tokens. A file whose stored bytes no longer match its
 * recorded hash is left out and named in the archive instead of being shipped.
 */
export async function buildDossierArchive(dossier: Dossier, dependencies: DossierArchiveDependencies = {}): Promise<Uint8Array> {
	const loadArtifact = dependencies.loadArtifact ?? ArtifactsEntity.get;
	const writer = new ZipWriter(new Uint8ArrayWriter());
	const add = (name: string, content: Uint8Array) => writer.add(name, new Uint8ArrayReader(content));
	await add("Dossier.txt", Buffer.from(dossierText(dossier), "utf8"));
	for (const attachment of dossierAttachments(dossier)) await add(attachment.name, attachment.content);
	await add("Dossier.json", Buffer.from(JSON.stringify(dossier, null, 2), "utf8"));
	const missing: string[] = [];
	for (const [index, site] of dossier.sites.entries()) {
		const folder = `Beweise/${String(index + 1).padStart(3, "0")}-${sanitizeFilename(site.host) || site.submissionId}`;
		const used = new Set<string>();
		// A case captured again keeps every capture: a repeated name gets its artifact id, the newest keeps the plain name.
		const newestFirst = [...site.evidence].sort((a, b) => (BigInt(b.artifactId) > BigInt(a.artifactId) ? 1 : -1));
		for (const file of newestFirst) {
			const artifact = await loadArtifact(BigInt(file.artifactId));
			const bytes = artifact ? Buffer.from(artifact.blob) : undefined;
			const hash = bytes ? new Bun.CryptoHasher("sha256").update(bytes).digest("hex") : undefined;
			if (!bytes || hash !== file.sha256) {
				missing.push(`${folder}/${file.name}: ${bytes ? "gespeicherte Bytes passen nicht zur Prüfsumme" : "nicht mehr gespeichert"}`);
				continue;
			}
			const name = sanitizeFilename(file.name) || file.artifactId;
			const unique = used.has(name) ? name.replace(/(\.[^.]*)?$/, (extension) => `.${file.artifactId}${extension}`) : name;
			used.add(unique);
			await add(`${folder}/${unique}`, bytes);
		}
	}
	if (missing.length) await add("Fehlende-Dateien.txt", Buffer.from(`${missing.join("\n")}\n`, "utf8"));
	return writer.close();
}

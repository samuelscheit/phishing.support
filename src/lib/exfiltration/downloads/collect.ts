import { safeArtifactUrl } from "../../abuse/skyvern/storage";
import { asString } from "../../abuse/skyvern/contracts";

/**
 * A file the Skyvern run reports it downloaded. Every field came from the remote
 * side, so it is validated here before any fetch or filesystem use. Skyvern's
 * own checksum is kept only for comparison; the hash we trust is computed locally.
 */
export type CollectedDownload = {
	url: URL;
	remoteName: string | undefined;
	reportedSha256: string | undefined;
};

const MAX_DOWNLOADS_PER_RUN = 5;

/**
 * Turn Skyvern's `downloaded_files` into fetchable downloads. Malformed or
 * unsafe entries are dropped, never repaired: a URL that is not a public HTTPS
 * storage location is refused rather than fetched.
 */
export function collectDownloads(downloadedFiles: unknown): CollectedDownload[] {
	if (!Array.isArray(downloadedFiles)) return [];
	const collected: CollectedDownload[] = [];
	for (const entry of downloadedFiles.slice(0, MAX_DOWNLOADS_PER_RUN)) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		let url: URL;
		try {
			url = safeArtifactUrl(asString(record.url));
		} catch {
			continue;
		}
		const checksum = asString(record.checksum);
		collected.push({
			url,
			remoteName: asString(record.filename),
			reportedSha256: checksum && /^[a-f0-9]{64}$/i.test(checksum) ? checksum.toLowerCase() : undefined,
		});
	}
	return collected;
}

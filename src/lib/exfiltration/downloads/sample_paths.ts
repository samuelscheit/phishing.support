import path from "node:path";

/**
 * Sample archives live under one operator-owned root. Every path is derived
 * from a validated SHA-256 (our own name for the file), never from the remote
 * filename, and is checked to stay inside the root before any filesystem use.
 */
const SHA256 = /^[a-f0-9]{64}$/;

export function sampleArchiveRelativePath(sha256: string): string {
	if (!SHA256.test(sha256)) throw new Error("A sample archive name must be a lowercase SHA-256 hash.");
	// Two-level fan-out keeps any single directory small.
	return path.posix.join(sha256.slice(0, 2), `${sha256}.zip`);
}

/** Resolve a relative archive path under `root`, refusing anything that escapes it. */
export function containedSamplePath(root: string, relative: string): string {
	if (!path.isAbsolute(root)) throw new Error("The sample store root must be an absolute path.");
	if (path.isAbsolute(relative) || relative.includes("\0")) throw new Error("A sample path must be relative and contain no NUL bytes.");
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(resolvedRoot, relative);
	const inside = resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
	if (!inside || resolved === resolvedRoot) throw new Error("A sample path escapes the sample store root.");
	return resolved;
}

/**
 * Sanitize a remote filename into a safe leaf name used only as archive metadata.
 * It never names a file on disk: separators, control characters, and dot-leading
 * names are removed, and length is capped.
 */
export function sanitizeRemoteFilename(name: string | undefined): string {
	// Normalize before splitting: compatibility forms such as a fullwidth solidus
	// become real separators under NFKC, so they must be split after normalization.
	const base = (name ?? "").normalize("NFKC").split(/[\\/]/).pop() ?? "";
	const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").replace(/[^A-Za-z0-9._ -]/g, "_").trim();
	const capped = cleaned.slice(0, 120);
	return capped || "sample.bin";
}

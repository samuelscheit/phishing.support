import type { AbuseArtifact } from "./schema";

/**
 * A stored artifact as a download: never rendered by the browser (it may be a
 * phishing page or a mail with active content), under its own sanitised name.
 * Artifacts never change once stored, so public ones may be cached.
 */
export function artifactResponse(artifact: Pick<AbuseArtifact, "blob" | "mimeType" | "name">, options: { access: "public" | "private"; charset?: string }): Response {
	return new Response(artifact.blob as unknown as BodyInit, {
		headers: {
			"content-type": options.charset ? `${artifact.mimeType}; charset=${options.charset}` : artifact.mimeType,
			"content-disposition": `attachment; filename="${artifact.name.replace(/[\r\n"\\]/g, "_")}"`,
			"cache-control": options.access === "public" ? "public, max-age=31536000, immutable" : "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

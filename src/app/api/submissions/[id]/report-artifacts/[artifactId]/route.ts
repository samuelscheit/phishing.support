import { AbuseRepository } from "@/lib/abuse/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve one artifact of a submission's report (sent reports, provider replies,
 * evidence). Submission pages are public; an artifact is served only when it
 * belongs to that submission's report.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; artifactId: string }> }) {
	const { id, artifactId } = await params;
	if (!/^\d+$/.test(id) || !/^\d+$/.test(artifactId)) return new Response("Not found", { status: 404 });
	const reports = await AbuseRepository.listReportsForSubmission(BigInt(id));
	let artifact;
	for (const report of reports) {
		artifact = await AbuseRepository.getArtifact(report.id, BigInt(artifactId));
		if (artifact) break;
	}
	if (!artifact) return new Response("Not found", { status: 404 });
	return new Response(artifact.blob as unknown as BodyInit, {
		headers: {
			"content-type": artifact.mimeType,
			"content-disposition": `attachment; filename="${artifact.name.replace(/[\r\n"\\]/g, "_")}"`,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

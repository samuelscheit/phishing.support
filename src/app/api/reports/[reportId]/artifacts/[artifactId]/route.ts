import { artifactResponse } from "@/lib/abuse/artifact_response";
import { AbuseRepository } from "@/lib/abuse/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve one artifact of a report (sent reports, provider replies, evidence).
 * Every report and its correspondence is public; an artifact is served only
 * under the report that owns it.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ reportId: string; artifactId: string }> }) {
	const { reportId, artifactId } = await params;
	if (!/^\d{1,20}$/.test(reportId) || !/^\d{1,20}$/.test(artifactId)) return new Response("Not found", { status: 404 });
	const artifact = await AbuseRepository.getArtifact(BigInt(reportId), BigInt(artifactId));
	if (!artifact) return new Response("Not found", { status: 404 });
	return artifactResponse(artifact, { access: "public" });
}

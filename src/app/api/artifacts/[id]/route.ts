import { ArtifactsEntity } from "@/lib/db/entities/artifacts";
import { artifactResponse } from "@/lib/http/artifact_response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve one artifact of a case (captures, chain bodies, evidence files, the
 * reported mail). Cases are public; a case can be deleted, so its files are
 * not cached.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^\d{1,20}$/.test(id)) return new Response("Not found", { status: 404 });
	const artifact = await ArtifactsEntity.get(BigInt(id));
	if (!artifact) return new Response("Not found", { status: 404 });
	return artifactResponse(artifact, { access: "private" });
}

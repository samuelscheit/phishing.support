import { artifactResponse } from "@/lib/abuse/artifact_response";
import { AbuseRepository } from "@/lib/abuse/repository";
import { operatorHandler, parseId } from "@/lib/referral/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A file attached to a referral mail, as it is or was sent. */
export async function GET(request: Request, { params }: { params: Promise<{ artifactId: string }> }) {
	return operatorHandler(request, async () => {
		const artifactId = parseId((await params).artifactId);
		const reportId = parseId(new URL(request.url).searchParams.get("report") ?? "");
		const artifact = artifactId !== undefined && reportId !== undefined ? await AbuseRepository.getArtifact(reportId, artifactId) : undefined;
		if (!artifact || artifact.kind !== "referral_attachment") return new Response("Not found", { status: 404 });
		return artifactResponse(artifact, { access: "private", charset: "utf-8" });
	});
}

import { NextRequest } from "next/server";

import { AbuseRepository } from "@/lib/abuse/repository";
import { verifyArtifactAccessToken } from "@/lib/abuse/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		if (!/^\d+$/.test(id)) return new Response("Not found", { status: 404 });
		const artifactId = BigInt(id);
		const artifact = await AbuseRepository.getArtifactById(artifactId);
		const accessToken = request.nextUrl.searchParams.get("accessToken");
		const report = artifact ? await AbuseRepository.getReport(artifact.reportId) : undefined;
		if (!artifact || !report || !accessToken || !verifyArtifactAccessToken(accessToken, artifact.id, report.trackingTokenHash)) return new Response("Not found", { status: 404 });
		return new Response(artifact.blob as unknown as BodyInit, {
			headers: {
				"content-type": artifact.mimeType,
				"content-disposition": `inline; filename="${artifact.name.replace(/[\r\n"\\]/g, "_")}"`,
				"cache-control": "private, no-store",
			},
		});
	} catch {
		return new Response("Not found", { status: 404 });
	}
}

import { NextRequest } from "next/server";
import { ArtifactsEntity } from "@/lib/db/entities/artifacts";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const artifactId = BigInt(id);

		const artifact = await ArtifactsEntity.get(artifactId);
		if (!artifact || !artifact.blob) {
			return new Response("Not found", { status: 404 });
		}

		const mimeType = artifact.mimeType || "application/octet-stream";
		const name = artifact.name || "artifact";

		// Serve the raw artifact bytes.
		return new Response(artifact.blob as unknown as BodyInit, {
			headers: {
				"Content-Type": mimeType,
				"Content-Disposition": `inline; filename="${name}"`,
			},
		});
	} catch (err) {
		console.error("Failed to get artifact:", err);
		return new Response("Internal Server Error", { status: 500 });
	}
}

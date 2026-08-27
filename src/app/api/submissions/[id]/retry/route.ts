import { NextResponse } from "next/server";

import { SubmissionRetryError, retryFailedEmailAnalysis } from "@/lib/submissions/email";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		let submissionId: bigint;
		try {
			submissionId = BigInt(id);
		} catch {
			return NextResponse.json({ error: "Invalid submission id" }, { status: 400 });
		}

		await retryFailedEmailAnalysis(submissionId);
		return NextResponse.json({ ok: true, status: "queued" });
	} catch (error) {
		if (error instanceof SubmissionRetryError) return NextResponse.json({ error: error.message }, { status: 409 });
		console.error("Failed to queue submission retry:", error);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}

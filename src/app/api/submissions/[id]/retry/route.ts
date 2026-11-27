import { NextResponse } from "next/server";

import { SubmissionRetryError, retryEmailAnalysis } from "@/lib/submissions/email";
import { retryWebsiteAnalysis } from "@/lib/submissions/website";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { parseReporterInstructions } from "@/lib/submissions/instructions";

export const runtime = "nodejs";

/** The retry's body: none keeps the stored instructions, `{ instructions }` replaces them (`{}` or null clears them). */
async function readRetryBody(request: Request): Promise<{ ok: true; replacement: { instructions?: ReturnType<typeof parseReporterInstructions> } } | { ok: false; error: string }> {
	const text = await request.text();
	if (!text.trim()) return { ok: true, replacement: {} };
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return { ok: false, error: "The request body is not valid JSON" };
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "The request body must be a JSON object" };
	return { ok: true, replacement: "instructions" in body ? { instructions: parseReporterInstructions(body.instructions) } : {} };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		let submissionId: bigint;
		try {
			submissionId = BigInt(id);
		} catch {
			return NextResponse.json({ error: "Invalid submission id" }, { status: 400 });
		}

		const body = await readRetryBody(request);
		if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
		const parsed = body.replacement.instructions;
		if (parsed && !parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

		const submission = await SubmissionsEntity.get(submissionId);
		if (submission?.kind === "website") {
			await retryWebsiteAnalysis(submissionId, parsed ? { instructions: parsed.instructions } : {});
			// The visit waits its turn in the visit queue.
			return NextResponse.json({ ok: true, status: "queued" });
		}
		if (parsed) return NextResponse.json({ error: "Instructions apply only to website submissions" }, { status: 400 });
		await retryEmailAnalysis(submissionId);
		return NextResponse.json({ ok: true, status: "running" });
	} catch (error) {
		if (error instanceof SubmissionRetryError) return NextResponse.json({ error: error.message }, { status: 409 });
		console.error("Failed to queue submission retry:", error);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}

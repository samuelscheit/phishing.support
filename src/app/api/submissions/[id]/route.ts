import { NextResponse } from "next/server";
import { getSubmissionDetails } from "@/lib/submissions/details";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
	try {
		const { id } = await params;
		const submission = await getSubmissionDetails(id);

		if (!submission) return NextResponse.json({ error: "Submission not found" }, { status: 404 });
		return NextResponse.json(submission);
	} catch (err) {
		console.error("Failed to get submission:", err);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}

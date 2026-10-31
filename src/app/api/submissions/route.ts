import { NextRequest, NextResponse } from "next/server";
import { listSubmissionCards, SubmissionCursorError } from "@/lib/submissions/list";

export async function GET(req: NextRequest) {
	try {
		const { searchParams } = req.nextUrl;
		const limit = searchParams.has("limit") ? Number(searchParams.get("limit")) : undefined;
		return NextResponse.json(await listSubmissionCards({ cursor: searchParams.get("cursor"), limit: Number.isFinite(limit) ? limit : undefined }));
	} catch (err) {
		if (err instanceof SubmissionCursorError) return NextResponse.json({ error: err.message }, { status: 400 });
		console.error("Failed to list submissions:", err);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}

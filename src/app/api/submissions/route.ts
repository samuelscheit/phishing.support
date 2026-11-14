import { NextRequest, NextResponse } from "next/server";
import { parseSubmissionFilters, SubmissionFilterError } from "@/lib/submissions/filters";
import { listSubmissionCards, SubmissionCursorError } from "@/lib/submissions/list";

/** `?status=running,phishing` keeps those status chips; without it every submission is listed. */
export async function GET(req: NextRequest) {
	try {
		const { searchParams } = req.nextUrl;
		const limit = searchParams.has("limit") ? Number(searchParams.get("limit")) : undefined;
		const status = searchParams.get("status");
		return NextResponse.json(await listSubmissionCards({
			cursor: searchParams.get("cursor"),
			limit: Number.isFinite(limit) ? limit : undefined,
			...(status === null ? {} : { filters: parseSubmissionFilters(status) }),
		}));
	} catch (err) {
		if (err instanceof SubmissionCursorError || err instanceof SubmissionFilterError) return NextResponse.json({ error: err.message }, { status: 400 });
		console.error("Failed to list submissions:", err);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}

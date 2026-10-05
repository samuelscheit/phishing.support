import { NextRequest, NextResponse } from "next/server";
import { createEmailSubmissionFromEml } from "@/lib/submissions/email";
import { getReporterMetadata } from "@/lib/request_metadata";

export async function POST(req: NextRequest) {
	try {
		const formData = await req.formData();
		const file = formData.get("file") as File;

		if (!file) {
			return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
		}

		const bytes = await file.arrayBuffer();
		const buffer = Buffer.from(bytes);
		const emlContent = buffer.toString("utf-8");

		console.log("Email submission received, size:", buffer.length);

		const reporter = await getReporterMetadata(req);
		const stream_id = await createEmailSubmissionFromEml(emlContent, { source: "web-upload", ...reporter });
		return NextResponse.json({ stream_id });
	} catch (err) {
		console.error("Submission error:", err);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}

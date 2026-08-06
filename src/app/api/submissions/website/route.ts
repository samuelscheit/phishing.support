import { NextRequest, NextResponse } from "next/server";
import { getUserCC } from "@/lib/utils";
import { createWebsiteSubmission } from "@/lib/submissions/website";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
	try {
		const { url, mhtml_base64 } = (await req.json()) as { url?: string; mhtml_base64?: string };

		if (!url) {
			return NextResponse.json({ error: "URL is required" }, { status: 400 });
		}

		let mhtmlSnapshot: Buffer | undefined;
		if (mhtml_base64) {
			const trimmed = String(mhtml_base64).trim();
			const base64 = trimmed.startsWith("data:") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
			try {
				mhtmlSnapshot = Buffer.from(base64, "base64");
			} catch {
				return NextResponse.json({ error: "Invalid mhtml_base64" }, { status: 400 });
			}

			// Basic safety bound: avoid extremely large payloads.
			const MAX_MHTML_BYTES = 25 * 1024 * 1024;
			if (mhtmlSnapshot.byteLength > MAX_MHTML_BYTES) {
				return NextResponse.json({ error: "MHTML snapshot too large" }, { status: 413 });
			}
		}

		const country_code = await getUserCC(req);
		console.log("Website submission from country:", country_code);
		const stream_id = await createWebsiteSubmission({ url, country_code, mhtmlSnapshot });

		return NextResponse.json({ stream_id });
	} catch (err) {
		console.error("Submission error:", err);
		return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
	}
}

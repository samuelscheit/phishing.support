import { NextRequest, NextResponse } from "next/server";

import { MAX_REQUEST_BYTES, validateAbuseReportRequest } from "@/lib/abuse/contracts";
import { AbuseInputError } from "@/lib/abuse/security";
import { AbuseRepository } from "@/lib/abuse/repository";
import { getReporterMetadata } from "@/lib/request_metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
	try {
		const length = Number(request.headers.get("content-length"));
		if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) {
			return NextResponse.json({ error: "Request is too large." }, { status: 413 });
		}
		const body = Buffer.from(await request.arrayBuffer());
		if (body.byteLength > MAX_REQUEST_BYTES) return NextResponse.json({ error: "Request is too large." }, { status: 413 });
		let payload: unknown;
		try {
			payload = JSON.parse(body.toString("utf8"));
		} catch {
			return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
		}
		const validated = await validateAbuseReportRequest(payload);
		const reporter = await getReporterMetadata(request);
		const created = await AbuseRepository.createReport({ request: validated, reporter });
		const statusUrl = new URL(`/abuse-reporting/${encodeURIComponent(created.trackingToken)}`, request.url).toString();
		return NextResponse.json({ trackingToken: created.trackingToken, status: "accepted", statusUrl }, { status: created.created ? 202 : 200 });
	} catch (error) {
		if (error instanceof AbuseInputError) return NextResponse.json({ error: error.message }, { status: error.status });
		console.error("Standalone abuse report creation failed:", error);
		return NextResponse.json({ error: "The report could not be accepted." }, { status: 500 });
	}
}

import { NextResponse } from "next/server";

import { AbuseRepository } from "@/lib/abuse/repository";
import { isTrackingToken } from "@/lib/abuse/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ trackingToken: string }> }) {
	const { trackingToken } = await params;
	if (!isTrackingToken(trackingToken)) return NextResponse.json({ error: "Report not found." }, { status: 404 });
	const status = await AbuseRepository.getPublicStatus(trackingToken);
	if (!status) return NextResponse.json({ error: "Report not found." }, { status: 404 });
	return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}

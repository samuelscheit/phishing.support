import type { NextRequest } from "next/server";
import type { WebSocket, WebSocketServer } from "ws";

import { serveLiveSocket } from "@/lib/site_visit/live_socket";

export const dynamic = "force-dynamic";

/**
 * A viewer's WebSocket to a case's live visit (next-ws): the screen, the
 * control state, and taking the browser over, driving it, handing it back
 * or writing to the agent. Anyone watching the live visit may; one person
 * drives at a time.
 */
export async function UPGRADE(client: WebSocket, _server: WebSocketServer, request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	serveLiveSocket(client, id, request.nextUrl.searchParams);
}

/** Plain HTTP gets told to upgrade. */
export function GET() {
	return Response.json({ error: "Connect with a WebSocket." }, { status: 426 });
}

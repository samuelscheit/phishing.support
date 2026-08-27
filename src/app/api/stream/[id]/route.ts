import { NextRequest } from "next/server";
import { subscribeToEvents } from "@/lib/event/event_transport";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const topic = `run:${id}`;

	const stream = new ReadableStream({
		async start(controller) {
			const sub = await subscribeToEvents(topic);

			controller.enqueue(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

			try {
				for await (const msgData of sub) {
					const payload = typeof msgData === "string" ? msgData : JSON.stringify(msgData);
					controller.enqueue(`data: ${payload}\n\n`);

					if (typeof msgData === "object" && msgData) {
						const message = msgData as { status?: string; type?: string };
						if (message.status === "completed" || message.status === "error" || message.type === "run.completed" || message.type === "run.failed") {
							break;
						}
					}
				}
			} catch (err) {
				console.error("SSE Stream error:", err);
			} finally {
				sub.close();
				controller.close();
			}
		},
		cancel() {
			// Handle cleanup if client disconnects
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

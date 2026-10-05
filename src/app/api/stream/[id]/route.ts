import { NextRequest } from "next/server";
import { subscribeToEvents } from "@/lib/event/event_transport";
import { projectSseEvent } from "@/lib/event/sse_projection";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const topic = `run:${id}`;
	const progressOnly = req.nextUrl.searchParams.get("progress") === "1";
	let cancelled = false;
	let sub: Awaited<ReturnType<typeof subscribeToEvents>> | null = null;
	const cancel = () => {
		cancelled = true;
		sub?.close();
	};

	const stream = new ReadableStream({
		async start(controller) {
			req.signal.addEventListener("abort", cancel, { once: true });
			try {
				sub = await subscribeToEvents(topic);
				if (cancelled) return;
				controller.enqueue(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
				for await (const msgData of sub) {
					const message =
						typeof msgData === "object" && msgData ? (msgData as { type?: string; step?: string; progress?: number }) : null;
					if (progressOnly && message?.type !== "analysis.step") {
						continue;
					}
					// Keep the browser stream semantic and bounded.  Internal Responses
					// packets can contain encrypted reasoning and large tool payloads;
					// the UI only needs the allow-listed projection.
					const payload = JSON.stringify(projectSseEvent(msgData));
					controller.enqueue(`data: ${payload}\n\n`);

					if (message) {
						if (progressOnly && (message.step === "completed" || message.step === "failed" || message.progress === 100)) {
							break;
						}
						if (progressOnly) continue;
						if (message.type === "run.completed" || message.type === "run.failed") {
							break;
						}
					}
				}
			} catch (err) {
				if (!cancelled) console.error("SSE Stream error:", err);
			} finally {
				sub?.close();
				req.signal.removeEventListener("abort", cancel);
				if (!cancelled) controller.close();
			}
		},
		cancel() {
			cancel();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

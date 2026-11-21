import { NextRequest } from "next/server";
import { subscribeToEvents } from "@/lib/event/event_transport";
import { projectSseEvent } from "@/lib/event/sse_projection";
import { withoutBackendSecrets } from "@/lib/exfiltration/secrets";

export const dynamic = "force-dynamic";

/**
 * A comment line on a quiet stream. Proxies in front of the app (the
 * Cloudflare tunnel) close a connection that sends nothing for about 100 s,
 * and a site visit can go minutes without a progress step; the browser
 * ignores comment lines.
 */
const KEEP_ALIVE_MS = 15_000;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const topic = `run:${id}`;
	const progressOnly = req.nextUrl.searchParams.get("progress") === "1";
	// The live browser view: the visit's events and the progress that ends it.
	const browserOnly = req.nextUrl.searchParams.get("browser") === "1";
	let cancelled = false;
	let sub: Awaited<ReturnType<typeof subscribeToEvents>> | null = null;
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	const cancel = () => {
		cancelled = true;
		clearInterval(keepAlive);
		sub?.close();
	};

	const stream = new ReadableStream({
		async start(controller) {
			req.signal.addEventListener("abort", cancel, { once: true });
			try {
				sub = await subscribeToEvents(topic);
				if (cancelled) return;
				controller.enqueue(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
				keepAlive = setInterval(() => {
					try {
						controller.enqueue(": keep-alive\n\n");
					} catch {
						clearInterval(keepAlive);
					}
				}, KEEP_ALIVE_MS);
				for await (const msgData of sub) {
					const message =
						typeof msgData === "object" && msgData ? (msgData as { type?: string; step?: string; progress?: number }) : null;
					if (progressOnly && message?.type !== "analysis.step") {
						continue;
					}
					if (browserOnly && message?.type !== "analysis.step" && !message?.type?.startsWith("browser.")) {
						continue;
					}
					// Keep the browser stream semantic and bounded.  Internal Responses
					// packets can contain encrypted reasoning and large tool payloads;
					// the UI only needs the allow-listed projection.
					const payload = JSON.stringify(withoutBackendSecrets(projectSseEvent(msgData)));
					controller.enqueue(`data: ${payload}\n\n`);

					if (message) {
						if ((progressOnly || browserOnly) && (message.step === "completed" || message.step === "failed" || message.progress === 100)) {
							break;
						}
						if (progressOnly || browserOnly) continue;
						if (message.type === "run.completed" || message.type === "run.failed") {
							break;
						}
					}
				}
			} catch (err) {
				if (!cancelled) console.error("SSE Stream error:", err);
			} finally {
				clearInterval(keepAlive);
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

import { NextRequest } from "next/server";

import { visitControlOf } from "@/lib/site_visit/control";
import type { LiveFrame } from "@/lib/site_visit/screen";

export const dynamic = "force-dynamic";

/** A comment line on a still screen, so proxies (the Cloudflare tunnel) keep the stream open. */
const KEEP_ALIVE_MS = 15_000;
/** People watching one visit's screen at once; each holds a frame in memory. */
const MAX_VIEWERS = 50;

/**
 * The live screen of a case's visit, as server-sent events of JPEG frames.
 * A frame is written only once the client took the one before: a slow
 * connection gets fewer, newer frames instead of a growing backlog.
 * `?quality=high` asks for the sharp, fluid screen (full screen, driving).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const control = visitControlOf(id);
	if (!control || control.mode === "ended") return Response.json({ error: "The visit is not live." }, { status: 404 });
	if (control.screen.viewers >= MAX_VIEWERS) return Response.json({ error: "Too many people watch this visit right now." }, { status: 429 });
	const quality = req.nextUrl.searchParams.get("quality") === "high" ? "high" : "low";

	let latest: LiveFrame | undefined;
	let wake: (() => void) | undefined;
	/** `ended`: the visit is over, the client hears so; `cancelled`: the client left, nothing more is written. */
	let state: "open" | "ended" | "cancelled" = "open";
	const stopWatching = control.screen.watch((frame) => {
		latest = frame;
		wake?.();
	}, quality);
	const finish = (why: "ended" | "cancelled") => {
		if (state !== "open") return;
		state = why;
		stopWatching();
		latest = undefined;
		req.signal.removeEventListener("abort", cancel);
		wake?.();
	};
	const cancel = () => finish("cancelled");
	req.signal.addEventListener("abort", cancel, { once: true });
	void control.screen.ended.then(() => finish("ended"));

	/** The next frame, or nothing when the screen stayed still for the keep-alive period. */
	const next = async (): Promise<LiveFrame | undefined> => {
		if (!latest && state === "open") {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, KEEP_ALIVE_MS);
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			wake = undefined;
		}
		const frame = latest;
		latest = undefined;
		return frame;
	};

	const stream = new ReadableStream<string>({
		start(controller) {
			controller.enqueue(": connected\n\n");
		},
		async pull(controller) {
			const frame = await next();
			if (state === "cancelled") return;
			if (state === "ended") {
				controller.enqueue("event: end\ndata: {}\n\n");
				controller.close();
				return;
			}
			controller.enqueue(frame ? `data: ${JSON.stringify(frame)}\n\n` : ": keep-alive\n\n");
		},
		cancel,
	}, { highWaterMark: 1 });

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

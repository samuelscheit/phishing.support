"use client";

import { useEffect, useReducer, useState } from "react";

import { EMPTY_LIVE_EVENTS, isLive, reduceLiveEvent, type LiveEvents } from "./live_state";

/** A frame of the live screen, ready to show: `width` × `height` is the page's CSS size, which input coordinates are in. */
export type LiveFrame = { src: string; url: string; width: number; height: number };
export type ScreenQuality = "low" | "high";

/** How long a refused screen connection waits before it tries again while the visit is still live. */
const SCREEN_RETRY_MS = 2_000;

function parse(data: string): unknown {
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}

/** The live screen while the visit is live: one connection, swapped when the quality changes. */
function useLiveScreen(submissionId: string, live: boolean, quality: ScreenQuality) {
	const [frame, setFrame] = useState<LiveFrame | null>(null);
	useEffect(() => {
		if (!live) return;
		let source: EventSource | undefined;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		const open = () => {
			source = new EventSource(`/api/live/${encodeURIComponent(submissionId)}/screen?quality=${quality}`);
			source.onmessage = (event: MessageEvent<string>) => {
				const parsed = parse(event.data) as Partial<{ jpeg: string; url: string; width: number; height: number }> | undefined;
				if (!parsed || typeof parsed.jpeg !== "string" || !(Number(parsed.width) > 0) || !(Number(parsed.height) > 0)) return;
				setFrame({ src: `data:image/jpeg;base64,${parsed.jpeg}`, url: typeof parsed.url === "string" ? parsed.url : "", width: Number(parsed.width), height: Number(parsed.height) });
			};
			source.addEventListener("end", () => {
				stopped = true;
				source?.close();
			});
			// A refused connection (404 while the visit is not live yet) is not retried by the browser itself.
			source.onerror = () => {
				if (stopped || source?.readyState !== EventSource.CLOSED) return;
				retry = setTimeout(open, SCREEN_RETRY_MS);
			};
		};
		open();
		return () => {
			stopped = true;
			clearTimeout(retry);
			source?.close();
		};
	}, [submissionId, live, quality]);
	return frame;
}

/**
 * A case's live visit while it runs: its log and control state from the
 * case's event stream, and its screen while people can watch it. The screen
 * is small until someone asks for the sharp one (`setQuality("high")`: full
 * screen or driving).
 */
export function useLiveVisit(submissionId: string, enabled: boolean) {
	const [events, dispatch] = useReducer(reduceLiveEvent, EMPTY_LIVE_EVENTS);
	const [quality, setQuality] = useState<ScreenQuality>("low");
	useEffect(() => {
		if (!enabled) return;
		const source = new EventSource(`/api/stream/${encodeURIComponent(submissionId)}?browser=1`);
		source.onmessage = (event: MessageEvent<string>) => dispatch(parse(event.data));
		return () => source.close();
	}, [submissionId, enabled]);
	const live = enabled && isLive(events);
	const frame = useLiveScreen(submissionId, live, quality);
	return { submissionId, ...events, live, frame, setQuality } satisfies LiveVisit;
}

/** A live visit as its views take it: what `useLiveVisit` returns, or a fixture. */
export type LiveVisit = LiveEvents & {
	submissionId: string;
	/** People can watch and drive it now. */
	live: boolean;
	/** The newest frame of the screen; kept after the visit ended. */
	frame: LiveFrame | null;
	setQuality: (quality: ScreenQuality) => void;
};

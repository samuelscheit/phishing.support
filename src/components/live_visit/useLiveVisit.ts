"use client";

import { useEffect, useReducer, useRef, useState } from "react";

import { liveSocketPath, type ScreenQuality } from "@/lib/site_visit/live_protocol";
import { LiveChannel } from "./live_channel";
import { EMPTY_LIVE_EVENTS, isLive, reduceLiveEvent, type LiveEvents } from "./live_state";

/** A frame of the live screen, ready to show: `width` × `height` is the page's CSS size, which input coordinates are in. */
export type LiveFrame = { src: string; url: string; width: number; height: number };

/** Where this browser tab keeps its viewer id: a reload keeps the controls, another tab is another viewer. */
const VIEWER_KEY = "liveVisitViewer";

/** This tab's viewer id: its key to the controls, never shown. */
function viewerId(): string {
	const stored = sessionStorage.getItem(VIEWER_KEY);
	if (stored && /^[A-Za-z0-9-]{16,64}$/.test(stored)) return stored;
	const created = crypto.randomUUID();
	sessionStorage.setItem(VIEWER_KEY, created);
	return created;
}

function parse(data: string): unknown {
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}

/**
 * The visit's socket while it is live: the screen as object URLs of its
 * frames (the one before the shown one is let go), the control state, and
 * whether this viewer drives.
 */
function useLiveChannel(submissionId: string, live: boolean, quality: ScreenQuality, dispatch: (message: unknown) => void) {
	const [channel, setChannel] = useState<LiveChannel>();
	const [connected, setConnected] = useState(false);
	const [you, setYou] = useState(false);
	const [frame, setFrame] = useState<LiveFrame | null>(null);
	const qualityRef = useRef(quality);
	qualityRef.current = quality;

	useEffect(() => {
		if (!live) return;
		const urls: string[] = [];
		const viewer = viewerId();
		const opened = new LiveChannel({
			url: (current) => liveSocketPath(submissionId, viewer, current),
			quality: qualityRef.current,
			handlers: {
				onFrame: (meta, jpeg) => {
					const src = URL.createObjectURL(new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
					urls.push(src);
					// The shown frame stays valid until the next one replaced it on screen.
					while (urls.length > 2) URL.revokeObjectURL(urls.shift()!);
					setFrame({ src, ...meta });
				},
				onControl: (control) => {
					setYou(control.you);
					dispatch(control);
				},
				onConnected: setConnected,
				onEnd: () => setYou(false),
			},
		});
		setChannel(opened);
		return () => {
			opened.close();
			setChannel(undefined);
			setConnected(false);
			setYou(false);
			// The last frame stays on screen after the visit; only the one before it is let go.
			while (urls.length > 1) URL.revokeObjectURL(urls.shift()!);
		};
	}, [submissionId, live, dispatch]);

	useEffect(() => channel?.setQuality(quality), [channel, quality]);
	return { channel, connected, you, frame };
}

/**
 * A case's live visit while it runs: its log from the case's event stream,
 * and while people can watch it, its socket: the screen, the control state
 * and the controls. The screen is small until someone asks for the sharp
 * one (`setQuality("high")`: full screen or driving).
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
	const { channel, connected, you, frame } = useLiveChannel(submissionId, live, quality, dispatch);
	return { submissionId, ...events, live, frame, you, channel, connected, setQuality } satisfies LiveVisit;
}

/** A live visit as its views take it: what `useLiveVisit` returns, or a fixture. */
export type LiveVisit = LiveEvents & {
	submissionId: string;
	/** People can watch and drive it now. */
	live: boolean;
	/** The newest frame of the screen; kept after the visit ended. */
	frame: LiveFrame | null;
	/** This viewer drives the browser (or is about to). */
	you: boolean;
	/** The visit's socket while it is live. */
	channel?: LiveChannel;
	connected: boolean;
	setQuality: (quality: ScreenQuality) => void;
};

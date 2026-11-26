"use client";

import { useEffect, useRef } from "react";

import type { LiveInput } from "@/lib/site_visit/live_input";
import { cn } from "@/lib/util/cn";
import { pageScale, toPagePoint, wheelPixels, type Point } from "./geometry";
import { keyInput, keyPress, textInputs } from "./keys";
import type { LiveFrame } from "./useLiveVisit";

const BUTTONS = ["left", "middle", "right"] as const;
/** Pointer moves sent per second at most: hover and drags. */
const MOVE_INTERVAL_MS = 33;
/** A press this soon and this close after the last one counts on (double, triple click). */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 5;
/** A finger held this long without moving drags instead of scrolling. */
const LONG_PRESS_MS = 450;
/** A finger that moved this far (screen px) scrolls. */
const SWIPE_PX = 8;

type Touch = { id: number; startClient: Point; start: Point; last: Point; mode: "pending" | "swipe" | "drag"; timer?: ReturnType<typeof setTimeout> };

/**
 * The live screen, fitted to its box at the page's shape. While its viewer
 * drives, the screen takes the pointer, wheel and keyboard: a mouse clicks,
 * hovers and drags; a finger taps, swipes to scroll and drags after a long
 * press; keys and pasted text go through a hidden field (the soft keyboard's
 * too, which `sinkRef` focuses).
 */
export function LiveScreen({ frame, driving, send, sinkRef, label, children }: {
	frame: LiveFrame | null;
	driving: boolean;
	send: (...inputs: LiveInput[]) => void;
	sinkRef: React.RefObject<HTMLTextAreaElement | null>;
	label: string;
	/** Shown over the screen: state notes. */
	children?: React.ReactNode;
}) {
	const stageRef = useRef<HTMLDivElement>(null);
	const screenRef = useRef<HTMLDivElement>(null);
	const dotRef = useRef<HTMLSpanElement>(null);
	const pressed = useRef<(typeof BUTTONS)[number] | null>(null);
	const lastMove = useRef(0);
	const lastDown = useRef<{ at: number; client: Point; count: number } | null>(null);
	const touch = useRef<Touch | null>(null);
	// The wheel listener is native (React's is passive): it reads the current props through a ref.
	const current = useRef({ frame, driving, send });
	useEffect(() => {
		current.current = { frame, driving, send };
	}, [frame, driving, send]);

	const pagePoint = (client: Point, clamp = false) => {
		const box = screenRef.current?.getBoundingClientRect();
		return box && frame ? toPagePoint(client, box, frame, { clamp }) : undefined;
	};

	/** Our own pointer over the page, drawn without React: it follows every move. */
	const showDot = (client: Point | undefined) => {
		const dot = dotRef.current;
		const box = screenRef.current?.getBoundingClientRect();
		if (!dot || !box) return;
		const inside = client && client.x >= box.left && client.x <= box.right && client.y >= box.top && client.y <= box.bottom;
		dot.style.opacity = inside ? "1" : "0";
		if (inside) dot.style.transform = `translate(${client.x - box.left}px, ${client.y - box.top}px)`;
	};

	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		const onWheel = (event: WheelEvent) => {
			const { frame: shown, driving: active, send: deliver } = current.current;
			const box = screenRef.current?.getBoundingClientRect();
			if (!active || !shown || !box) return;
			const point = toPagePoint({ x: event.clientX, y: event.clientY }, box, shown);
			if (!point) return;
			event.preventDefault();
			deliver({ type: "wheel", ...point, ...wheelPixels(event, shown) });
		};
		stage.addEventListener("wheel", onWheel, { passive: false });
		return () => stage.removeEventListener("wheel", onWheel);
	}, []);

	useEffect(() => {
		const sink = sinkRef.current;
		if (!sink || !driving) return;
		// A soft keyboard's Backspace and Enter come without usable key events.
		const onBeforeInput = (event: InputEvent) => {
			if (event.inputType === "deleteContentBackward") {
				event.preventDefault();
				current.current.send(...keyPress("Backspace"));
			} else if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
				event.preventDefault();
				current.current.send(...keyPress("Enter"));
			}
		};
		sink.addEventListener("beforeinput", onBeforeInput);
		return () => sink.removeEventListener("beforeinput", onBeforeInput);
	}, [driving, sinkRef]);

	useEffect(() => {
		if (!driving) {
			pressed.current = null;
			touch.current = null;
			showDot(undefined);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [driving]);

	const flushSink = () => {
		const sink = sinkRef.current;
		if (!sink?.value) return;
		send(...textInputs(sink.value));
		sink.value = "";
	};

	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (!driving || !frame) return;
		const client = { x: event.clientX, y: event.clientY };
		const point = pagePoint(client);
		if (!point) return;
		event.preventDefault();
		if (event.pointerType === "touch") {
			if (touch.current) return;
			const gesture: Touch = { id: event.pointerId, startClient: client, start: point, last: client, mode: "pending" };
			gesture.timer = setTimeout(() => {
				if (touch.current !== gesture || gesture.mode !== "pending") return;
				gesture.mode = "drag";
				send({ type: "pointer", phase: "down", ...gesture.start, button: "left", clickCount: 1 });
			}, LONG_PRESS_MS);
			touch.current = gesture;
			showDot(client);
			return;
		}
		const button = BUTTONS[event.button];
		if (!button) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		sinkRef.current?.focus({ preventScroll: true });
		const previous = lastDown.current;
		const count = previous && event.timeStamp - previous.at < MULTI_CLICK_MS && Math.hypot(client.x - previous.client.x, client.y - previous.client.y) < MULTI_CLICK_PX ? Math.min(3, previous.count + 1) : 1;
		lastDown.current = { at: event.timeStamp, client, count };
		pressed.current = button;
		send({ type: "pointer", phase: "down", ...point, button, clickCount: count });
	};

	const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
		if (!driving || !frame) return;
		const client = { x: event.clientX, y: event.clientY };
		const gesture = touch.current;
		if (event.pointerType === "touch") {
			if (!gesture || gesture.id !== event.pointerId) return;
			if (gesture.mode === "pending" && Math.hypot(client.x - gesture.startClient.x, client.y - gesture.startClient.y) >= SWIPE_PX) {
				clearTimeout(gesture.timer);
				gesture.mode = "swipe";
			}
			const box = screenRef.current?.getBoundingClientRect();
			if (gesture.mode === "swipe" && box) {
				const scale = pageScale(box, frame);
				const deltaX = Math.round((gesture.last.x - client.x) * scale * 100) / 100;
				const deltaY = Math.round((gesture.last.y - client.y) * scale * 100) / 100;
				if (deltaX || deltaY) send({ type: "wheel", ...gesture.start, deltaX, deltaY });
			} else if (gesture.mode === "drag") {
				const point = pagePoint(client, true);
				if (point) send({ type: "pointer", phase: "move", ...point, button: "left", clickCount: 1 });
			}
			gesture.last = client;
			showDot(client);
			return;
		}
		showDot(client);
		if (event.timeStamp - lastMove.current < MOVE_INTERVAL_MS) return;
		const point = pagePoint(client, Boolean(pressed.current));
		if (!point) return;
		lastMove.current = event.timeStamp;
		send({ type: "pointer", phase: "move", ...point, button: pressed.current ?? "left", clickCount: 1 });
	};

	const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
		const client = { x: event.clientX, y: event.clientY };
		const gesture = touch.current;
		if (event.pointerType === "touch") {
			if (!gesture || gesture.id !== event.pointerId) return;
			clearTimeout(gesture.timer);
			touch.current = null;
			if (!driving) return;
			if (gesture.mode === "pending") {
				send({ type: "pointer", phase: "down", ...gesture.start, button: "left", clickCount: 1 }, { type: "pointer", phase: "up", ...gesture.start, button: "left", clickCount: 1 });
			} else if (gesture.mode === "drag") {
				send({ type: "pointer", phase: "up", ...(pagePoint(client, true) ?? gesture.start), button: "left", clickCount: 1 });
			}
			return;
		}
		const button = pressed.current;
		if (!button) return;
		pressed.current = null;
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		const point = pagePoint(client, true);
		if (driving && point) send({ type: "pointer", phase: "up", ...point, button, clickCount: lastDown.current?.count ?? 1 });
	};

	const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
		const gesture = touch.current;
		if (gesture?.id === event.pointerId) {
			clearTimeout(gesture.timer);
			touch.current = null;
			if (gesture.mode === "drag" && driving) send({ type: "pointer", phase: "up", ...gesture.start, button: "left", clickCount: 1 });
		}
	};

	const ratio = frame ? frame.width / frame.height : 16 / 9;

	return (
		<div
			ref={stageRef}
			className={cn("relative flex h-full w-full select-none items-center justify-center [container-type:size]", driving && "touch-none")}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerCancel}
			onPointerLeave={() => showDot(undefined)}
			onContextMenu={(event) => {
				if (driving) event.preventDefault();
			}}
		>
			<div
				ref={screenRef}
				className={cn(
					"relative overflow-hidden rounded-lg bg-muted shadow-[0_0_0_1px_oklch(0_0_0/0.1),0_8px_24px_-8px_oklch(0_0_0/0.25)] dark:shadow-[0_0_0_1px_oklch(1_0_0/0.1),0_8px_24px_-8px_oklch(0_0_0/0.6)]",
					driving && "cursor-none ring-2 ring-sky-500 ring-offset-2 ring-offset-background",
				)}
				style={{ width: `min(100cqw, calc(100cqh * ${ratio}))`, aspectRatio: `${frame?.width ?? 16} / ${frame?.height ?? 9}` }}
			>
				{frame ? (
					// eslint-disable-next-line @next/next/no-img-element
					<img src={frame.src} alt={label} draggable={false} className="absolute inset-0 h-full w-full object-contain" />
				) : null}
				{driving ? (
					<span ref={dotRef} aria-hidden className="pointer-events-none absolute left-0 top-0 opacity-0 transition-opacity duration-100 motion-reduce:transition-none">
						<span className="absolute -left-2 -top-2 h-4 w-4 rounded-full border-2 border-white bg-sky-500/80 shadow-[0_0_0_1px_oklch(0_0_0/0.35)]" />
					</span>
				) : null}
				{children}
			</div>
			{driving ? (
				<textarea
					ref={sinkRef}
					aria-label="Keyboard input for the site: keys you press here are sent to the page"
					autoCapitalize="off"
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
					// 16px keeps iOS from zooming in when the field takes focus.
					className="pointer-events-none absolute bottom-0 left-1/2 h-px w-px resize-none overflow-hidden border-0 bg-transparent p-0 text-[16px] text-transparent caret-transparent opacity-0"
					onKeyDown={(event) => {
						const input = keyInput(event.nativeEvent, "down");
						if (!input) return;
						event.preventDefault();
						send(input);
					}}
					onKeyUp={(event) => {
						const input = keyInput(event.nativeEvent, "up");
						if (input) send(input);
					}}
					onPaste={(event) => {
						event.preventDefault();
						const text = event.clipboardData.getData("text/plain");
						if (text) send(...textInputs(text));
					}}
					onInput={(event) => {
						if (!(event.nativeEvent as InputEvent).isComposing) flushSink();
					}}
					onCompositionEnd={flushSink}
				/>
			) : null}
		</div>
	);
}

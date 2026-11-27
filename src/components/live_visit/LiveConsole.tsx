"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Globe, Loader2, Minimize2, PanelRightClose, PanelRightOpen, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Address } from "@/components/Address";
import { scrollToEnd } from "@/components/scrollToEnd";
import { ControlDock } from "./ConsoleControls";
import { DriverBadge, RecordingChip, TabStrip, TurnCountdown } from "./ConsoleStatus";
import { LiveScreen } from "./LiveScreen";
import { LiveEntryRow } from "./VisitLog";
import { useLiveDriver, type LiveDriver } from "./useLiveDriver";
import type { LiveVisit } from "./useLiveVisit";

/** Wide screens open the console with its timeline beside the screen. */
const DRAWER_OPEN_FROM_PX = 1024;

/**
 * The console in full screen: the Fullscreen API on the console itself, or
 * where there is none (iPhone Safari) a fixed layer over the page. Leaving
 * full screen (the browser's own Escape) closes the console.
 */
function useFullscreen(ref: React.RefObject<HTMLElement | null>, enabled: boolean, onExit: () => void) {
	const exit = useRef(onExit);
	useEffect(() => {
		exit.current = onExit;
	}, [onExit]);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const previousOverflow = document.documentElement.style.overflow;
		document.documentElement.style.overflow = "hidden";
		let entered = false;
		const onChange = () => {
			if (document.fullscreenElement === element) entered = true;
			else if (entered) exit.current();
		};
		document.addEventListener("fullscreenchange", onChange);
		if (enabled && document.fullscreenEnabled && element.requestFullscreen) void element.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
		return () => {
			document.removeEventListener("fullscreenchange", onChange);
			document.documentElement.style.overflow = previousOverflow;
			if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => undefined);
		};
	}, [ref, enabled]);
}

/** A note over the screen: who has the browser, what the visit does, or why there is nothing to drive. */
export function ScreenNote({ children, busy }: { children: React.ReactNode; busy?: boolean }) {
	return (
		<div role="status" className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
			<p className="flex max-w-[min(36rem,100%)] items-center gap-2 rounded-2xl bg-background/90 px-3 py-1.5 text-xs font-medium shadow-md ring-1 ring-border backdrop-blur">
				{busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : null}
				<span className="min-w-0 break-words">{children}</span>
			</p>
		</div>
	);
}

/**
 * The live browser console of a case's visit: the screen as large as it
 * fits, who drives and for how long, the controls to take over and drive,
 * and the visit's timeline beside it. `onClose` leaves it; a driver hands
 * the browser back as it leaves, since only the console can drive.
 */
export function LiveConsole({ visit, driver, onClose, fullscreen = true }: {
	visit: LiveVisit;
	driver: LiveDriver;
	onClose: () => void;
	/** Ask the browser for full screen (off in fixtures, which a headless browser shows as the fixed layer). */
	fullscreen?: boolean;
}) {
	const root = useRef<HTMLDivElement>(null);
	const sinkRef = useRef<HTMLTextAreaElement>(null);
	const logRef = useRef<HTMLOListElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const [drawer, setDrawer] = useState(() => typeof window !== "undefined" && window.innerWidth >= DRAWER_OPEN_FROM_PX);
	const { control, frame, entries, setQuality } = visit;
	const { status } = driver;
	const driving = status.kind === "you";
	const holding = driving || (status.kind === "pausing" && status.mine);
	const ended = !visit.live;

	const closed = useRef(false);
	// Escape reaches both the console and (in full screen) the browser, which leaves full screen: close once.
	const close = () => {
		if (closed.current) return;
		closed.current = true;
		if (holding) void driver.release();
		onClose();
	};
	useFullscreen(root, fullscreen, close);

	useEffect(() => {
		setQuality("high");
		return () => setQuality("low");
	}, [setQuality]);

	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null;
		closeRef.current?.focus();
		return () => opener?.focus?.();
	}, []);

	// The keyboard goes to the page as the turn starts, on devices with a hardware keyboard.
	useEffect(() => {
		if (driving && window.matchMedia("(pointer: fine)").matches) sinkRef.current?.focus({ preventScroll: true });
	}, [driving]);

	useEffect(() => {
		if (drawer) scrollToEnd(logRef.current?.lastElementChild);
	}, [entries.length, drawer]);

	const url = frame?.url || control?.tabs.find((tab) => tab.active)?.url || "";
	const tabs = control?.tabs ?? [];
	const hasScreenNote = !frame || ended || (status.kind === "loading" && Boolean(status.status)) || status.kind === "pausing" || status.kind === "other";

	const view = (
		<div
			ref={root}
			role="dialog"
			aria-modal="true"
			aria-label="Live view of the visit"
			className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
			onKeyDown={(event) => {
				if (event.key === "Escape" && !event.defaultPrevented) {
					event.preventDefault();
					close();
					return;
				}
				// A modal: Tab cycles through the console's own controls (in the page's field it goes to the page).
				if (event.key !== "Tab" || event.defaultPrevented) return;
				const focusable = [...root.current!.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => element !== sinkRef.current && element.offsetParent !== null);
				const first = focusable[0];
				const last = focusable.at(-1);
				if (!first || !last) return;
				const active = document.activeElement;
				if (event.shiftKey && (active === first || !root.current!.contains(active))) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && (active === last || !root.current!.contains(active))) {
					event.preventDefault();
					first.focus();
				}
			}}
		>
			{/* On a phone the address takes its own row under the status. */}
			<header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-2 py-2 sm:flex-nowrap sm:px-3">
				{ended ? null : <RecordingChip />}
				<div className="order-last flex min-w-0 basis-full items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs sm:order-none sm:flex-1 sm:basis-auto" title={url}>
					<Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
					<span className="sr-only">Page shown: </span>
					{/* One line: Chrome breaks at an address's <wbr> even where wrapping is off. */}
					<span className="min-w-0 truncate [&_wbr]:hidden">{url ? <Address url={url} /> : "…"}</span>
				</div>
				<DriverBadge status={status} live={!hasScreenNote} />
				<TurnCountdown control={control} />
				<span className="flex-1 sm:hidden" aria-hidden />
				<Button type="button" variant="ghost" size="icon" onClick={() => setDrawer(!drawer)} aria-pressed={drawer} aria-label={drawer ? "Hide the timeline" : "Show the timeline"} title={drawer ? "Hide the timeline" : "Show the timeline"} className="shrink-0">
					{drawer ? <PanelRightClose /> : <PanelRightOpen />}
				</Button>
				<Button ref={closeRef} type="button" variant="ghost" size="icon" onClick={close} aria-label={holding ? "Hand back and leave the live view" : "Leave the live view"} title={holding ? "Hand back and leave (Esc)" : "Leave (Esc)"} className="shrink-0">
					{fullscreen ? <Minimize2 /> : <X />}
				</Button>
			</header>
			{tabs.length > 1 ? <TabStrip tabs={tabs} onSelect={driving ? (targetId) => driver.send({ type: "tab", targetId }) : undefined} /> : null}
			{holding ? (
				<p className="flex shrink-0 items-start gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100 sm:items-center">
					<AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 sm:mt-0" aria-hidden />
					<span>Everything you type is sent to the site and kept in the case record; use made-up values. Your turn ends after 60 s without input.</span>
				</p>
			) : null}
			{driver.error ? (
				<div role="alert" className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
					<span className="min-w-0 flex-1">{driver.error}</span>
					<button type="button" onClick={driver.dismissError} className="rounded p-0.5 hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Dismiss">
						<X className="h-3.5 w-3.5" />
					</button>
				</div>
			) : null}
			<div className="relative flex min-h-0 flex-1">
				<div className="flex min-w-0 flex-1 flex-col gap-3 bg-muted/40 p-3 dark:bg-black/30">
					<div className="min-h-0 flex-1">
						<LiveScreen frame={frame} driving={driving} send={driver.send} sinkRef={sinkRef} label={`The visited site, live: ${url}`}>
							{ended ? <div className="absolute inset-0 bg-background/40 backdrop-grayscale" aria-hidden /> : null}
							{!frame ? <ScreenNote busy={!ended && status.kind !== "loading" && status.kind !== "pausing"}>{ended ? "The visit ended." : control?.status ?? "Connecting to the browser…"}</ScreenNote>
								: ended ? <ScreenNote>The visit ended. Everything it did is in the case record.</ScreenNote>
									: status.kind === "loading" && status.status ? <ScreenNote>{status.status}</ScreenNote>
										: status.kind === "pausing" ? <ScreenNote>{status.mine ? "The agent finishes its action; the browser is yours in a moment." : `${status.label ?? "Someone"} is taking over…`}</ScreenNote>
											: status.kind === "other" ? <ScreenNote>{status.label} is driving the browser.</ScreenNote>
												: null}
						</LiveScreen>
					</div>
					{ended ? (
						<div className="flex justify-center">
							<Button type="button" variant="outline" onClick={close}>
								<Minimize2 />
								Leave the live view
							</Button>
						</div>
					) : <ControlDock driver={driver} control={control} onKeyboard={() => sinkRef.current?.focus()} />}
				</div>
				{drawer ? (
					<aside aria-label="Timeline of the visit" className="absolute inset-y-0 right-0 z-10 flex w-[min(22rem,88vw)] flex-col border-l bg-background shadow-xl lg:static lg:shadow-none">
						<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
							<h2 className="text-sm font-semibold">Timeline</h2>
							<span className="flex items-center gap-2 text-[11px] text-muted-foreground">
								<span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-muted-foreground/40" aria-hidden />Agent</span>
								<span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" aria-hidden />Person</span>
							</span>
						</div>
						<ol ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-1" aria-live="polite" aria-label="What the visit did">
							{entries.map((entry, index) => <LiveEntryRow key={index} entry={entry} />)}
							{!entries.length ? <li className="py-2 text-xs text-muted-foreground">Nothing yet.</li> : null}
						</ol>
					</aside>
				) : null}
			</div>
		</div>
	);
	return createPortal(view, document.body);
}

/** The console of a case's live visit, with this viewer's controls. */
export function LiveVisitConsole({ visit, onClose }: { visit: LiveVisit; onClose: () => void }) {
	const driver = useLiveDriver(visit);
	return <LiveConsole visit={visit} driver={driver} onClose={onClose} />;
}

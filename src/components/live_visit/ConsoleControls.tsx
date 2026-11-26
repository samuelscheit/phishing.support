"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Camera, ChevronUp, Hand, Keyboard, Loader2, RotateCw, Send, Undo2, WandSparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/util/cn";
import type { SyntheticField } from "@/lib/site_visit/visit_task";
import { fieldLabel, type LiveControl } from "./live_state";
import type { LiveDriver } from "./useLiveDriver";

/**
 * A panel that opens above its button and stays inside the console (a
 * portal would not show in full screen). Escape and a press outside close
 * it; focus moves into it and back to its button.
 */
function Popover({ label, icon, disabled, children, align = "start", panelClassName, compact }: {
	label: string;
	/** Only the icon on a phone; the label stays for screen readers. */
	compact?: boolean;
	icon: React.ReactNode;
	disabled?: boolean;
	children: (close: () => void) => React.ReactNode;
	align?: "start" | "end";
	panelClassName?: string;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const id = useId();
	const close = (refocus = true) => {
		setOpen(false);
		if (refocus) trigger.current?.focus();
	};
	useEffect(() => {
		if (!open) return;
		panel.current?.querySelector<HTMLElement>("textarea, input, button")?.focus();
		const onPointerDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open]);
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);
	return (
		<div ref={root} className="relative max-sm:static">
			<Button ref={trigger} type="button" variant="ghost" size="sm" disabled={disabled} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className={cn("h-9 shrink-0", compact && "max-sm:gap-1 max-sm:px-2")} title={compact ? label : undefined}>
				{icon}
				<span className={cn(compact && "max-sm:sr-only")}>{label}</span>
				<ChevronUp className={cn("!size-3.5 text-muted-foreground transition-transform duration-150 max-sm:hidden motion-reduce:transition-none", !open && "rotate-180")} aria-hidden />
			</Button>
			{open ? (
				<div
					ref={panel}
					id={id}
					role="dialog"
					aria-label={label}
					onKeyDown={(event) => {
						if (event.key !== "Escape") return;
						event.stopPropagation();
						close();
					}}
					className={cn(
						"absolute bottom-full z-20 mb-2 w-72 origin-bottom rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none",
						align === "end" ? "right-0" : "left-0",
						panelClassName,
						// On a phone the panel spans the dock above it.
						"max-sm:inset-x-0 max-sm:w-auto",
					)}
				>
					{children(() => close())}
				</div>
			) : null}
		</div>
	);
}

/** Hand the browser back to the agent, with a note it reads first. */
export function HandBack({ driver }: { driver: LiveDriver }) {
	const [note, setNote] = useState("");
	return (
		<Popover label="Hand back" icon={<Undo2 />} disabled={driver.busy.release}>
			{(close) => (
				<form
					className="space-y-2 p-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						void driver.release(note).then(() => setNote(""));
						close();
					}}
				>
					<label className="block text-xs font-medium" htmlFor="hand-back-note">Note for the agent <span className="font-normal text-muted-foreground">(optional)</span></label>
					<Textarea id="hand-back-note" value={note} maxLength={500} rows={3} onChange={(event) => setNote(event.target.value)} placeholder="e.g. I solved the captcha; continue with the login form." className="text-sm" />
					<Button type="submit" size="sm" className="w-full">
						<Undo2 />
						Hand back to the agent
					</Button>
				</form>
			)}
		</Popover>
	);
}

/** The visit's made-up values, entered into the page's focused field with one click. */
export function FakeValues({ values, onInsert, disabled }: { values: LiveControl["fakeValues"]; onInsert: (field: SyntheticField) => void; disabled?: boolean }) {
	const fields = Object.entries(values) as Array<[SyntheticField, string]>;
	return (
		<Popover label="Made-up value" icon={<WandSparkles />} disabled={disabled || !fields.length} panelClassName="w-80" compact>
			{(close) => (
				<div>
					<p className="px-2 pb-1.5 pt-1 text-[11px] text-muted-foreground">Click a field in the page first; the value goes where its cursor is.</p>
					<ul className="max-h-72 overflow-y-auto">
						{fields.map(([field, value]) => (
							<li key={field}>
								<button
									type="button"
									onClick={() => {
										onInsert(field);
										close();
									}}
									className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
								>
									<span className="shrink-0 text-muted-foreground">{fieldLabel(field)}</span>
									<span className="min-w-0 truncate font-mono">{value}</span>
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</Popover>
	);
}

/** Write to the agent: it reads the message at its next turn. */
export function MessageAgent({ driver, className }: { driver: LiveDriver; className?: string }) {
	const [text, setText] = useState("");
	const sending = Boolean(driver.busy.message);
	return (
		<form
			className={cn("flex min-w-0 items-center gap-1 focus-within:ring-1 focus-within:ring-ring", className)}
			onSubmit={(event) => {
				event.preventDefault();
				if (!text.trim() || sending) return;
				void driver.message(text).then((sent) => {
					if (sent) setText("");
				});
			}}
		>
			<input
				value={text}
				maxLength={500}
				onChange={(event) => setText(event.target.value)}
				placeholder="Message the agent…"
				aria-label="Message the agent"
				className="h-9 min-w-0 flex-1 bg-transparent px-2.5 text-base placeholder:text-muted-foreground focus-visible:outline-none md:text-sm"
			/>
			<Button type="submit" size="icon" variant="ghost" disabled={!text.trim() || sending} aria-label="Send the message to the agent" title="Send">
				{sending ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Send />}
			</Button>
		</form>
	);
}

function Separator() {
	return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}

/** An icon button of the dock, named for screen readers and pointers. */
function DockButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
	return (
		<Button type="button" variant="ghost" size="icon" onClick={onClick} disabled={disabled} aria-label={label} title={label} className="shrink-0 max-sm:w-8 active:scale-[0.96] transition-[background-color,scale] duration-150 motion-reduce:transition-none">
			{children}
		</Button>
	);
}

/**
 * The console's controls: take the browser over, or while driving hand it
 * back, move through history, enter made-up values, record the page and
 * open the soft keyboard; and the message to the agent while it walks.
 */
export function ControlDock({ driver, control, onKeyboard }: { driver: LiveDriver; control: LiveControl | undefined; onKeyboard: () => void }) {
	const { status } = driver;
	const mine = status.kind === "you" || (status.kind === "pausing" && status.mine);
	const ready = status.kind === "you";
	const canTake = status.kind === "agent";
	const takeHint = status.kind === "other" ? `${status.label} is driving; you can take over once they hand back.`
		: status.kind === "pausing" ? "Someone is taking over."
			: status.kind === "finishing" ? "The agent is finishing the visit."
				: status.kind === "ended" ? "The visit ended." : undefined;
	return (
		<div className="flex w-full flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-center">
			<div role="toolbar" aria-label="Browser controls" className="relative flex max-w-full flex-wrap self-center items-center justify-center gap-0.5 rounded-xl border bg-card p-1 shadow-sm">
				{mine ? (
					<>
						<HandBack driver={driver} />
						<Separator />
						<DockButton label="Back" onClick={() => driver.send({ type: "history", direction: "back" })} disabled={!ready}><ArrowLeft /></DockButton>
						<DockButton label="Forward" onClick={() => driver.send({ type: "history", direction: "forward" })} disabled={!ready}><ArrowRight /></DockButton>
						<DockButton label="Reload" onClick={() => driver.send({ type: "reload" })} disabled={!ready}><RotateCw /></DockButton>
						<Separator />
						<FakeValues values={control?.fakeValues ?? {}} onInsert={(field) => driver.send({ type: "fake", field })} disabled={!ready} />
						<Button type="button" variant="ghost" size="sm" className="h-9 shrink-0 max-sm:px-2" disabled={!ready} onClick={() => driver.send({ type: "capture" })} title="Record this page as a step of the visit, with its screenshot">
							<Camera />
							<span className="max-sm:sr-only">Record page</span>
						</Button>
						<span className="contents [@media(pointer:fine)]:hidden">
							<DockButton label="Open the keyboard" onClick={onKeyboard} disabled={!ready}><Keyboard /></DockButton>
						</span>
					</>
				) : (
					<>
						<Button type="button" size="sm" className="h-9 shrink-0 active:scale-[0.96] transition-[background-color,scale] duration-150 motion-reduce:transition-none" disabled={!canTake || driver.busy.take} onClick={() => void driver.take()}>
							{driver.busy.take ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Hand />}
							Take over
						</Button>
						{takeHint ? <span className="px-2 text-xs text-muted-foreground">{takeHint}</span> : null}
					</>
				)}
			</div>
			{control?.agentRunning ? <MessageAgent driver={driver} className="w-full rounded-xl border bg-card p-1 shadow-sm sm:w-80" /> : null}
		</div>
	);
}

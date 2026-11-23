"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckSquare, Download, Flag, Globe, Keyboard, ListChecks, MousePointerClick, Send, ShieldAlert, Sparkles, Upload } from "lucide-react";

import { cn } from "../lib/util/cn";
import { canaryFieldList, type WebsiteOfferedDownload, type WebsiteVisitRecord } from "@/lib/website/types";
import { Address } from "./Address";
import { hostOf } from "@/lib/network/url";
import { OfferedFile } from "@/components/OfferedFile";

/** One page of the visit, with its screenshot when the case kept one. */
export type SiteVisitPage = { url: string; screenshotId?: string };

type LiveEntry =
	| { kind: "step"; url: string; title: string }
	| { kind: "action"; text: string; actionKind: string }
	| { kind: "download"; fileName: string; url: string };

const MAX_LIVE_ENTRIES = 200;


/** The live screen and log of a visit while it runs, from the case's event stream. */
function useLiveVisit(submissionId: string, enabled: boolean) {
	const [frame, setFrame] = useState<{ jpeg: string; url: string } | null>(null);
	const [entries, setEntries] = useState<LiveEntry[]>([]);
	useEffect(() => {
		if (!enabled) return;
		const source = new EventSource(`/api/stream/${encodeURIComponent(submissionId)}?browser=1`);
		source.onmessage = (event: MessageEvent<string>) => {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(event.data) as Record<string, unknown>;
			} catch {
				return;
			}
			const text = (key: string) => (typeof parsed[key] === "string" ? parsed[key] as string : "");
			if (parsed.type === "browser.frame" && text("jpeg")) setFrame({ jpeg: text("jpeg"), url: text("url") });
			const entry: LiveEntry | undefined = parsed.type === "browser.step"
				? { kind: "step", url: text("url"), title: text("title") }
				: parsed.type === "browser.action"
					? { kind: "action", text: text("text"), actionKind: text("kind") }
					: parsed.type === "browser.download"
						? { kind: "download", fileName: text("fileName"), url: text("url") }
						: undefined;
			if (entry) setEntries((current) => [...current, entry].slice(-MAX_LIVE_ENTRIES));
		};
		return () => source.close();
	}, [submissionId, enabled]);
	return { frame, entries };
}

/** The live screen and log of a running visit, shared by its browser and its timeline. */
export type LiveVisit = ReturnType<typeof useLiveVisit>;
export { useLiveVisit };

/**
 * The one browser of a case: the address bar of the page shown, with the
 * button that opens the submitted site, and below it the live screen while
 * the visit runs, or the screenshot of the page picked in the strip after.
 * `viewport` frames have the desktop viewport's 2:1 shape; a stored
 * screenshot takes its own height, up to most of the window, and scrolls.
 */
export function SiteVisitBrowser({ running, pages, initialPage, live: { frame }, fallbackUrl, openAction }: {
	running: boolean;
	pages: SiteVisitPage[];
	/** The page shown until another is picked: the one the case's verdict rests on; the last page by default. */
	initialPage?: number;
	live: LiveVisit;
	/** The address shown before the visit reached any page: the submitted URL. */
	fallbackUrl: string;
	/** The control that opens the submitted site, in the address bar. */
	openAction?: React.ReactNode;
}) {
	const [selected, setSelected] = useState<number | null>(null);
	const shown = selected ?? (initialPage !== undefined && initialPage < pages.length ? initialPage : pages.length - 1);
	const page = pages[shown];
	const hosts = new Set(pages.map(({ url }) => hostOf(url)));
	const live = running && Boolean(frame);
	const url = live ? frame!.url : page?.url ?? fallbackUrl;
	const fit = !live && page?.screenshotId ? "content" : "viewport";

	return (
		<div className="overflow-hidden rounded-lg border bg-card shadow-sm">
			<div className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2">
				<div className="flex gap-1.5" aria-hidden>
					<span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
					<span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
					<span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
				</div>
				<div className="min-w-0 flex-1 truncate rounded-md bg-background px-2.5 py-1 font-mono text-xs" title={url}>
					<Address url={url} />
				</div>
				{live ? (
					<span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
						<span className="relative flex h-1.5 w-1.5">
							<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60 motion-reduce:hidden" />
							<span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-destructive" />
						</span>
						Live
					</span>
				) : null}
				{openAction}
			</div>
			<div className={cn("relative w-full bg-background", fit === "viewport" ? "aspect-[2/1]" : "max-h-[70vh] overflow-y-auto")}>
				{live ? (
					// eslint-disable-next-line @next/next/no-img-element
					<img src={`data:image/jpeg;base64,${frame!.jpeg}`} alt="The visited site, live" className="absolute inset-0 h-full w-full object-contain object-top" />
				) : page?.screenshotId ? (
					<a href={`/api/artifacts/${page.screenshotId}`} target="_blank" rel="noreferrer" className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" title="Open the full screenshot">
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img src={`/api/artifacts/${page.screenshotId}`} alt={`Page ${shown + 1} of the visit: ${page.url}`} className="block h-auto w-full" />
					</a>
				) : (
					<div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{running ? "Waiting for the browser…" : "No screenshot of this page."}</div>
				)}
			</div>
			{!live && pages.length > 1 ? (
				<ol className="flex gap-2 overflow-x-auto border-t p-2" aria-label="Pages of the visit">
					{pages.map((candidate, index) => (
						<li key={`${index}:${candidate.url}`} className="shrink-0">
							<button
								type="button"
								title={candidate.url}
								onClick={() => setSelected(index)}
								aria-current={index === shown ? "step" : undefined}
								className={cn("w-28 overflow-hidden rounded-md border text-left transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", index === shown ? "border-primary ring-1 ring-primary" : "hover:border-foreground/30")}
							>
								<div className="relative aspect-[2/1] bg-muted">
									{candidate.screenshotId ? (
										// eslint-disable-next-line @next/next/no-img-element
										<img src={`/api/artifacts/${candidate.screenshotId}`} alt="" className="absolute inset-0 h-full w-full object-cover object-top" />
									) : null}
								</div>
								<div className="truncate px-1.5 py-1 text-[10px] text-muted-foreground"><span className="font-medium text-foreground">{index + 1}</span> · {pageLabel(candidate.url, hosts.size > 1)}</div>
							</button>
						</li>
					))}
				</ol>
			) : null}
		</div>
	);
}


/** A page's label in the strip: its path, led by its host when the visit passed several hosts. */
function pageLabel(url: string, withHost: boolean): string {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/") return parsed.host;
		return withHost ? `${parsed.host.replace(/^www\./, "")}${parsed.pathname}` : parsed.pathname;
	} catch {
		return url;
	}
}

/** An icon for each kind of agent action; anything else is a click. */
function actionIcon(kind: string): React.ReactNode {
	const Icon = kind === "input_text" || kind === "keypress" ? Keyboard
		: kind === "select_option" ? ListChecks
			: kind === "checkbox" ? CheckSquare
				: kind === "upload_file" ? Upload
					: kind === "download_file" ? Download
						: kind === "goto_url" ? Globe
							: kind === "complete" || kind === "terminate" ? Flag
								: MousePointerClick;
	return <Icon className="h-3 w-3" />;
}

function TimelineRow({ icon, tone = "muted", children }: { icon: React.ReactNode; tone?: "muted" | "danger"; children: React.ReactNode }) {
	return (
		<li className="flex gap-2.5 py-1.5">
			<span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full", tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>{icon}</span>
			<div className="min-w-0 flex-1 text-xs leading-relaxed">{children}</div>
		</li>
	);
}

/**
 * What the visit did: the agent walking the site as a victim would, live while
 * the case runs and from its record afterwards, with where the synthetic data
 * went and what it downloaded.
 */
export function SiteVisitTimeline({ running, visit, offeredDownload, live: { entries }, pageCount }: {
	running: boolean;
	visit?: WebsiteVisitRecord;
	offeredDownload?: WebsiteOfferedDownload;
	live: LiveVisit;
	pageCount: number;
}) {
	const logRef = useRef<HTMLOListElement>(null);
	useEffect(() => {
		logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
	}, [entries.length]);
	const thirdParty = useMemo(() => (visit?.dataSent ?? []).filter((sent) => !sent.sameSite), [visit]);
	if (!running && !visit) return null;
	// Counted from the network recording, never from the agent's own account.
	const sent = visit?.dataSent.length;
	const summary = [
		running ? "Running" : visit?.outcome === "completed" ? "Finished" : visit?.outcome === "timed_out" ? "Ran out of time" : "Did not finish",
		sent === undefined ? undefined : sent ? `made-up data sent in ${sent} request${sent === 1 ? "" : "s"}` : "no made-up data sent",
		pageCount ? `${pageCount} page${pageCount === 1 ? "" : "s"}` : undefined,
	].filter(Boolean).join(" · ");
	const note = visit?.report?.stoppedReason ?? visit?.failure;

	return (
		<section className="rounded-lg border bg-card p-4" aria-labelledby="site-visit-heading">
			<h2 id="site-visit-heading" className="text-sm font-semibold">The visit</h2>
			<p className="mt-0.5 text-xs text-muted-foreground">An agent walks the site as its victim would, entering only made-up data.</p>
			<p className={cn("mt-2 text-xs", visit && visit.outcome !== "completed" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
				<span className="font-medium">{summary}</span>{note ? <> · {note}</> : null}
			</p>
			<ol ref={logRef} className="mt-2 max-h-[28rem] overflow-y-auto pr-1" aria-label="What the visit did" aria-live={running ? "polite" : undefined}>
				{(running ? entries : (visit?.actions ?? []).map((action): LiveEntry => ({ kind: "action", text: action.text, actionKind: action.kind }))).map((entry, index) => (
					entry.kind === "step" ? (
						<TimelineRow key={index} icon={<Sparkles className="h-3 w-3" />}>
							Reached <span className="font-mono">{hostOf(entry.url)}</span>{entry.title ? <span className="text-muted-foreground"> · {entry.title}</span> : null}
						</TimelineRow>
					) : entry.kind === "download" ? (
						<TimelineRow key={index} icon={<Download className="h-3 w-3" />} tone="danger">
							Downloaded <span className="font-mono">{entry.fileName}</span>
						</TimelineRow>
					) : (
						<TimelineRow key={index} icon={actionIcon(entry.actionKind)}>{entry.text}</TimelineRow>
					)
				))}
				{!running && thirdParty.map((sent, index) => (
					<TimelineRow key={`sent-${index}`} icon={<Send className="h-3 w-3" />} tone="danger">
						Sent the made-up {canaryFieldList(sent.fields)} to <span className="font-mono">{sent.url.slice(0, 160)}</span>
					</TimelineRow>
				))}
				{!running && offeredDownload ? (
					<TimelineRow icon={<ShieldAlert className="h-3 w-3" />} tone="danger">
						Downloaded <OfferedFile download={offeredDownload} />, inspected without running it
					</TimelineRow>
				) : null}
				{running && entries.length === 0 ? <li className="py-2 text-xs text-muted-foreground">The agent is starting…</li> : null}
			</ol>
		</section>
	);
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCopy, Maximize2, Send, ShieldAlert } from "lucide-react";

import { cn } from "../lib/util/cn";
import { canaryFieldList, type WebsiteOfferedDownload, type WebsiteVisitRecord } from "@/lib/website/types";
import { Address } from "./Address";
import { scrollToEnd } from "./scrollToEnd";
import { hostOf } from "@/lib/network/url";
import { OfferedFile } from "@/components/OfferedFile";
import { isPasteCommand } from "@/lib/malware/paste_commands";
import { LiveVisitConsole } from "./live_visit/LiveConsole";
import type { LiveEntry } from "./live_visit/live_state";
import type { LiveVisit } from "./live_visit/useLiveVisit";
import { LiveEntryRow, TimelineRow } from "./live_visit/VisitLog";

/** One page of the visit, with its screenshot and the screenshot cut to what the page drew, when the case kept them. */
export type SiteVisitPage = { url: string; screenshotId?: string; previewId?: string };

/** Characters of a copied text the timeline shows; its tooltip holds the rest. */
const MAX_SHOWN_COPY = 400;

/**
 * The one browser of a case: the address bar of the page shown, with the
 * button that opens the submitted site, and below it the live screen while
 * the visit runs, which opens the live console (full screen, take over,
 * message the agent), or the page picked in the strip after: its preview (the
 * screenshot cut to what the page drew), else its screenshot, linking to the
 * full screenshot. `viewport` frames have the desktop viewport's 2:1 shape; a
 * stored picture takes its own height, up to most of the window, and scrolls.
 * A picture narrower than the frame, a kit's card, keeps its own width and
 * sits centred on a muted ground instead of being blown up.
 */
export function SiteVisitBrowser({ running, pages, initialPage, live: liveVisit, fallbackUrl, openAction }: {
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
	const [consoleOpen, setConsoleOpen] = useState(false);
	const shown = selected ?? (initialPage !== undefined && initialPage < pages.length ? initialPage : pages.length - 1);
	const page = pages[shown];
	const hosts = new Set(pages.map(({ url }) => hostOf(url)));
	const { frame } = liveVisit;
	const live = running && liveVisit.live && Boolean(frame);
	const url = live ? frame!.url : page?.url ?? fallbackUrl;
	const picture = page?.previewId ?? page?.screenshotId;
	const fit = !live && picture ? "content" : "viewport";

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
			<div className={cn("relative w-full", fit === "viewport" ? "aspect-[2/1] bg-background" : "max-h-[70vh] overflow-y-auto bg-muted/50")}>
				{live ? (
					<button
						type="button"
						onClick={() => setConsoleOpen(true)}
						aria-label="Open the live view: watch in full screen, take over the browser or message the agent"
						className="group absolute inset-0 block cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					>
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img src={frame!.src} alt="The visited site, live" className="absolute inset-0 h-full w-full object-contain object-top" />
						<span className="absolute bottom-2.5 right-2.5 flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium text-foreground shadow-md ring-1 ring-border backdrop-blur transition-[background-color,scale] duration-150 group-hover:bg-background group-active:scale-[0.96] motion-reduce:transition-none">
							<Maximize2 className="h-3.5 w-3.5" aria-hidden />
							Open live view
						</span>
					</button>
				) : picture ? (
					<a href={`/api/artifacts/${page.screenshotId ?? picture}`} target="_blank" rel="noreferrer" className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" title="Open the full screenshot">
						{/* eslint-disable-next-line @next/next/no-img-element */}
						<img src={`/api/artifacts/${picture}`} alt={`Page ${shown + 1} of the visit: ${page.url}`} className="mx-auto block h-auto max-w-full" />
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
									{candidate.previewId ?? candidate.screenshotId ? (
										// eslint-disable-next-line @next/next/no-img-element
										<img src={`/api/artifacts/${candidate.previewId ?? candidate.screenshotId}`} alt="" className="absolute inset-0 h-full w-full object-cover object-top" />
									) : null}
								</div>
								<div className="truncate px-1.5 py-1 text-[10px] text-muted-foreground"><span className="font-medium text-foreground">{index + 1}</span> · {pageLabel(candidate.url, hosts.size > 1)}</div>
							</button>
						</li>
					))}
				</ol>
			) : null}
			{consoleOpen && liveVisit.frame ? <LiveVisitConsole visit={liveVisit} onClose={() => setConsoleOpen(false)} /> : null}
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

/**
 * What the visit did: the agent walking the site as a victim would, live while
 * the case runs and from its record afterwards, with where the synthetic data
 * went and what it downloaded. What a person did after taking the browser
 * over is marked as theirs. `routeName` names the route the visit walked
 * when the case's link rotated to several.
 */
export function SiteVisitTimeline({ running, visit, offeredDownload, live: { entries }, pageCount, routeName }: {
	running: boolean;
	visit?: WebsiteVisitRecord;
	offeredDownload?: WebsiteOfferedDownload;
	live: LiveVisit;
	pageCount: number;
	routeName?: string;
}) {
	const logRef = useRef<HTMLOListElement>(null);
	useEffect(() => {
		scrollToEnd(logRef.current?.lastElementChild);
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
			<h2 id="site-visit-heading" className="text-sm font-semibold">The visit{routeName ? <span className="font-normal text-muted-foreground"> · {routeName}</span> : null}</h2>
			<p className="mt-0.5 text-xs text-muted-foreground">An agent walks the site as its victim would, entering only made-up data.</p>
			<p className={cn("mt-2 text-xs", visit && visit.outcome !== "completed" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
				<span className="font-medium">{summary}</span>{note ? <> · {note}</> : null}
			</p>
			<ol ref={logRef} className="mt-2 max-h-[28rem] overflow-y-auto pr-1" aria-label="What the visit did" aria-live={running ? "polite" : undefined}>
				{(running ? entries : (visit?.actions ?? []).map((action): LiveEntry => ({ kind: "action", text: action.text, actionKind: action.kind, actor: action.actor }))).map((entry, index) => (
					<LiveEntryRow key={index} entry={entry} />
				))}
				{!running && thirdParty.map((sent, index) => (
					<TimelineRow key={`sent-${index}`} icon={<Send className="h-3 w-3" />} tone="danger">
						Sent the made-up {canaryFieldList(sent.fields)} to <span className="font-mono">{sent.url.slice(0, 160)}</span>
					</TimelineRow>
				))}
				{!running && (visit?.clipboardWrites ?? []).map((write, index) => (
					<TimelineRow key={`copied-${index}`} icon={<ClipboardCopy className="h-3 w-3" />} tone={isPasteCommand(write.text) ? "danger" : "muted"}>
						The page put on the clipboard <span className="break-all font-mono" title={write.text}>{write.text.length > MAX_SHOWN_COPY ? `${write.text.slice(0, MAX_SHOWN_COPY)}…` : write.text}</span>
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

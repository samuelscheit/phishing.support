"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, MousePointerClick, Send, ShieldAlert, Sparkles } from "lucide-react";

import { cn } from "../web_lib/util";
import { CANARY_FIELD_LABEL, type CanaryField, type WebsiteOfferedDownload, type WebsiteVisitRecord } from "@/lib/website_types";

/** One page of the visit, with its screenshot when the case kept one. */
export type SiteVisitPage = { url: string; screenshotId?: string };

type LiveEntry =
	| { kind: "step"; url: string; title: string }
	| { kind: "action"; text: string; actionKind: string }
	| { kind: "download"; fileName: string; url: string };

const MAX_LIVE_ENTRIES = 200;

function fieldList(fields: readonly CanaryField[]): string {
	const labels = fields.map((field) => CANARY_FIELD_LABEL[field]);
	return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

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

function BrowserChrome({ url, live, children }: { url: string; live: boolean; children: React.ReactNode }) {
	return (
		<div className="overflow-hidden rounded-lg border bg-muted/30 shadow-sm">
			<div className="flex items-center gap-2 border-b bg-muted/60 px-3 py-2">
				<div className="flex gap-1.5" aria-hidden>
					<span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
					<span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
					<span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30" />
				</div>
				<div className="min-w-0 flex-1 truncate rounded-md bg-background px-2.5 py-1 font-mono text-[11px] text-muted-foreground" title={url}>
					{url || "about:blank"}
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
			</div>
			<div className="relative aspect-[4/3] w-full bg-background">{children}</div>
		</div>
	);
}

function TimelineRow({ icon, tone = "muted", children }: { icon: React.ReactNode; tone?: "muted" | "danger"; children: React.ReactNode }) {
	return (
		<li className="flex gap-2.5 py-1.5">
			<span className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full", tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground")}>{icon}</span>
			<div className="min-w-0 flex-1 break-words text-xs leading-relaxed">{children}</div>
		</li>
	);
}

/**
 * The visit through a reported site: the agent walking it as a victim would,
 * live while the case runs and replayed afterwards from each page it reached,
 * with what it did, where the synthetic data went, and what it downloaded.
 */
export function SiteVisitPanel({ submissionId, running, pages, visit, offeredDownload }: {
	submissionId: string;
	running: boolean;
	pages: SiteVisitPage[];
	visit?: WebsiteVisitRecord;
	offeredDownload?: WebsiteOfferedDownload;
}) {
	const { frame, entries } = useLiveVisit(submissionId, running);
	const [selected, setSelected] = useState<number | null>(null);
	const logRef = useRef<HTMLOListElement>(null);
	const shown = selected ?? pages.length - 1;
	const page = pages[shown];
	const live = running && Boolean(frame);

	useEffect(() => {
		logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
	}, [entries.length]);

	const thirdParty = useMemo(() => (visit?.dataSent ?? []).filter((sent) => !sent.sameSite), [visit]);
	if (!running && !visit && pages.length < 2) return null;

	return (
		<section className="space-y-3" aria-labelledby="site-visit-heading">
			<div className="flex items-baseline justify-between gap-2">
				<h4 id="site-visit-heading" className="text-sm font-semibold">Site visit</h4>
				<p className="text-xs text-muted-foreground">An agent walks the site as its victim would, entering only made-up data.</p>
			</div>
			<div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
				<div className="space-y-2">
					<BrowserChrome url={live ? frame!.url : page?.url ?? ""} live={live}>
						{live ? (
							// eslint-disable-next-line @next/next/no-img-element
							<img src={`data:image/jpeg;base64,${frame!.jpeg}`} alt="The visited site, live" className="absolute inset-0 h-full w-full object-contain object-top" />
						) : page?.screenshotId ? (
							// A page screenshot is the whole page: it fills the frame's width from its top, and opens in full.
							<a href={`/api/artifacts/${page.screenshotId}`} target="_blank" rel="noreferrer" className="absolute inset-0 overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" title="Open the full screenshot">
								{/* eslint-disable-next-line @next/next/no-img-element */}
								<img src={`/api/artifacts/${page.screenshotId}`} alt={`Page ${shown + 1} of the visit: ${page.url}`} className="block h-auto w-full" />
							</a>
						) : (
							<div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">{running ? "Waiting for the browser…" : "No screenshot of this page."}</div>
						)}
					</BrowserChrome>
					{!live && pages.length > 1 ? (
						<ol className="flex gap-2 overflow-x-auto pb-1" aria-label="Pages of the visit">
							{pages.map((candidate, index) => (
								<li key={`${index}:${candidate.url}`} className="shrink-0">
									<button
										type="button"
										onClick={() => setSelected(index)}
										aria-current={index === shown ? "step" : undefined}
										className={cn("w-28 overflow-hidden rounded-md border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", index === shown ? "border-primary ring-1 ring-primary" : "hover:border-foreground/30")}
									>
										<div className="relative aspect-[4/3] bg-muted">
											{candidate.screenshotId ? (
												// eslint-disable-next-line @next/next/no-img-element
												<img src={`/api/artifacts/${candidate.screenshotId}`} alt="" className="absolute inset-0 h-full w-full object-cover object-top" />
											) : null}
										</div>
										<div className="truncate px-1.5 py-1 text-[10px] text-muted-foreground"><span className="font-medium text-foreground">{index + 1}</span> · {hostOf(candidate.url)}</div>
									</button>
								</li>
							))}
						</ol>
					) : null}
				</div>

				<div className="min-w-0 space-y-3">
					{visit ? (
						<div className={cn("rounded-md border px-3 py-2 text-xs", visit.outcome === "completed" ? "bg-muted/30" : "border-amber-500/40 bg-amber-500/5")}>
							<span className="font-medium">{visit.outcome === "completed" ? "Visit finished" : visit.outcome === "timed_out" ? "Visit ran out of time" : "Visit did not finish"}</span>
							{visit.report?.stoppedReason ? <span className="text-muted-foreground"> — {visit.report.stoppedReason}</span> : visit.failure ? <span className="text-muted-foreground"> — {visit.failure}</span> : null}
						</div>
					) : null}
					<ol ref={logRef} className="max-h-96 overflow-y-auto pr-1" aria-label="What the visit did" aria-live={running ? "polite" : undefined}>
						{(running ? entries : [
							...(visit?.actions ?? []).map((action): LiveEntry => ({ kind: "action", text: action.text, actionKind: action.kind })),
						]).map((entry, index) => (
							entry.kind === "step" ? (
								<TimelineRow key={index} icon={<Sparkles className="h-3 w-3" />}>
									Reached <span className="font-mono">{hostOf(entry.url)}</span>{entry.title ? <span className="text-muted-foreground"> — {entry.title}</span> : null}
								</TimelineRow>
							) : entry.kind === "download" ? (
								<TimelineRow key={index} icon={<Download className="h-3 w-3" />} tone="danger">
									Downloaded <span className="font-mono">{entry.fileName}</span>
								</TimelineRow>
							) : (
								<TimelineRow key={index} icon={<MousePointerClick className="h-3 w-3" />}>{entry.text}</TimelineRow>
							)
						))}
						{!running && thirdParty.map((sent, index) => (
							<TimelineRow key={`sent-${index}`} icon={<Send className="h-3 w-3" />} tone="danger">
								Sent the made-up {fieldList(sent.fields)} to <span className="break-all font-mono">{sent.url.slice(0, 160)}</span>
							</TimelineRow>
						))}
						{!running && offeredDownload ? (
							<TimelineRow icon={<ShieldAlert className="h-3 w-3" />} tone="danger">
								Downloaded <span className="font-mono">{offeredDownload.fileName}</span> ({offeredDownload.sizeBytes.toLocaleString()} bytes), inspected without running it
							</TimelineRow>
						) : null}
						{running && entries.length === 0 ? <li className="py-2 text-xs text-muted-foreground">The agent is starting…</li> : null}
					</ol>
				</div>
			</div>
		</section>
	);
}

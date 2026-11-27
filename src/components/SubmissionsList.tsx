"use client";

import { SubmissionFilterChips } from "@/components/SubmissionFilterChips";
import { SubmissionStatus } from "@/components/SubmissionStatus";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/util/cn";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SUBMISSION_FILTERS, isSubmissionFilter, type SubmissionFilter } from "@/lib/submissions/filters";
import type { SubmissionCard as SubmissionCardData, SubmissionListItem, SubmissionListPage } from "@/lib/submissions/list";
import { hostOf } from "@/lib/network/url";

const PREVIEW_ROWS = 3;
const FILTERS_STORAGE_KEY = "phishing-support:submission-filters";

/** The chips the reader picked last time on this browser, or the default. */
function storedFilters(): SubmissionFilter[] {
	try {
		const stored: unknown = JSON.parse(window.localStorage.getItem(FILTERS_STORAGE_KEY) ?? "null");
		if (Array.isArray(stored) && stored.every(isSubmissionFilter)) return [...new Set(stored)];
	} catch {
		// Unreadable or blocked storage: fall back to the default.
	}
	return [...DEFAULT_SUBMISSION_FILTERS];
}

function storeFilters(filters: readonly SubmissionFilter[]) {
	try {
		window.localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
	} catch {
		// Storage blocked: the choice lasts for this page only.
	}
}

function getGridColumnCount() {
	if (typeof window === "undefined") return 1;

	if (window.matchMedia("(min-width: 1024px)").matches) return 3;
	if (window.matchMedia("(min-width: 768px)").matches) return 2;
	return 1;
}

function useGridColumnCount() {
	const [columnCount, setColumnCount] = useState(1);

	useEffect(() => {
		const updateColumnCount = () => {
			const nextColumnCount = getGridColumnCount();
			setColumnCount((currentColumnCount) =>
				currentColumnCount === nextColumnCount ? currentColumnCount : nextColumnCount
			);
		};

		updateColumnCount();
		window.addEventListener("resize", updateColumnCount);
		return () => window.removeEventListener("resize", updateColumnCount);
	}, []);

	return columnCount;
}

/** The frame every tile of the list shares: one link, its status line, its title and an optional note. */
function ListTileFrame({ href, label, obscured, badge, meta, createdAt, title, note }: {
	href: string;
	/** The link's accessible name, when the title alone does not say where it leads. */
	label?: string;
	obscured: boolean;
	badge: React.ReactNode;
	meta?: string;
	createdAt: string;
	title: string;
	note?: string;
}) {
	return (
		<Link
			href={href}
			aria-label={label}
			aria-hidden={obscured || undefined}
			tabIndex={obscured ? -1 : undefined}
			className={cn(
				"block h-full min-w-0 transition-[filter,opacity] duration-500 ease-out",
				obscured && "pointer-events-none select-none opacity-35 blur-sm"
			)}
		>
			<Card className="hover:bg-accent transition-colors cursor-pointer h-full w-full">
				<CardContent className="py-4 space-y-2 min-w-0">
					<div className="flex justify-between items-start gap-2">
						<span className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
							{badge}
							{meta ? <span className="text-xs leading-none text-muted-foreground">{meta}</span> : null}
						</span>
						<span className="text-xs text-muted-foreground whitespace-nowrap">
							{formatDistanceToNow(new Date(createdAt), { addSuffix: true })}
						</span>
					</div>
					<CardTitle className="text-lg truncate min-w-0">{title}</CardTitle>
					{note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
				</CardContent>
			</Card>
		</Link>
	);
}

function SubmissionCard({ submission, obscured = false }: { submission: SubmissionCardData; obscured?: boolean }) {
	return (
		<ListTileFrame
			href={`/submissions/${submission.id}`}
			obscured={obscured}
			badge={<SubmissionStatus status={submission.status} reportedAs={submission.reportedAs} />}
			createdAt={submission.createdAt}
			title={submission.title}
		/>
	);
}

type ListItem = SubmissionListItem;

/** "1 visiting · 4 queued": how the listed cases of a group stand. */
function pendingSummary(running: number, queued: number): string {
	return [running ? `${running} visiting` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(" · ");
}

function CampaignCard({ item, obscured = false }: { item: Extract<ListItem, { type: "campaign" }>; obscured?: boolean }) {
	const size = item.domain ? (item.hostCount > 1 ? `${item.hostCount} hosts` : "") : item.siteCount > 1 ? `${item.siteCount} sites` : "";
	return (
		<ListTileFrame
			href={`/campaigns/${item.campaignId}`}
			obscured={obscured}
			badge={<SubmissionStatus status="reported" />}
			meta={size}
			createdAt={item.newest.createdAt}
			// Without a shared domain every case of the tile is a member, so the newest names the campaign.
			title={item.domain ?? hostOf(item.newest.title)}
			note={item.pending ? `${item.pending} more in progress` : undefined}
		/>
	);
}

/** The hosts of one domain in no campaign yet: one tile, opening the newest. */
function SiteGroupCard({ item, obscured = false }: { item: Extract<ListItem, { type: "siteGroup" }>; obscured?: boolean }) {
	const status = item.runningCount ? "running" : item.queuedCount ? "queued" : item.newest.status;
	return (
		<ListTileFrame
			href={`/submissions/${item.newest.id}`}
			label={`${item.siteGroup}, ${item.size} hosts`}
			obscured={obscured}
			badge={<SubmissionStatus status={status} />}
			meta={[`${item.size} hosts`, pendingSummary(item.runningCount, item.queuedCount)].filter(Boolean).join(" · ")}
			createdAt={item.newest.createdAt}
			title={item.siteGroup}
		/>
	);
}

function ListTile({ item, obscured }: { item: ListItem; obscured?: boolean }) {
	if (item.type === "campaign") return <CampaignCard item={item} obscured={obscured} />;
	if (item.type === "siteGroup") return <SiteGroupCard item={item} obscured={obscured} />;
	return <SubmissionCard submission={item.submission} obscured={obscured} />;
}

async function fetchPage(filters: readonly SubmissionFilter[], cursor?: string): Promise<SubmissionListPage> {
	const query = new URLSearchParams({ status: filters.join(",") });
	if (cursor) query.set("cursor", cursor);
	const res = await fetch(`/api/submissions?${query}`);
	if (!res.ok) throw new Error(`Listing submissions failed with HTTP ${res.status}`);
	return res.json();
}

/** Newest page first, then older pages; every tile appears once, at its newest occurrence. */
function mergePages(newest: ListItem[], older: ListItem[]): ListItem[] {
	const seen = new Set<string>();
	const merged: ListItem[] = [];
	for (const item of [...newest, ...older]) {
		if (seen.has(item.key)) continue;
		seen.add(item.key);
		merged.push(item);
	}
	return merged;
}

/**
 * Recent submissions of the status chips the reader picked (running and
 * phishing by default, remembered on this browser): the newest page refreshes
 * every five seconds, and once expanded, older pages load as the reader
 * scrolls to the end of the list.
 */
export function SubmissionsList() {
	// `null` until the stored choice is read, so the default never flashes in before it.
	const [filters, setFilters] = useState<SubmissionFilter[] | null>(null);
	const [counts, setCounts] = useState<SubmissionListPage["counts"]>();
	// Set while the cards on screen still belong to the previous choice of chips.
	const [switching, setSwitching] = useState(false);
	const filtersRef = useRef(filters);
	const [newest, setNewest] = useState<ListItem[]>([]);
	const [older, setOlder] = useState<ListItem[]>([]);
	// `undefined` until the first page arrives; `null` once every page is loaded.
	const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [loading, setLoading] = useState(true);
	const [expanded, setExpanded] = useState(false);
	const sentinel = useRef<HTMLDivElement>(null);
	const items = mergePages(newest, older);
	const columnCount = useGridColumnCount();
	const previewSubmissionCount = columnCount * PREVIEW_ROWS;
	const hasMoreSubmissions = items.length > previewSubmissionCount || Boolean(nextCursor);
	const isCollapsed = hasMoreSubmissions && !expanded;
	const visibleItems = isCollapsed ? items.slice(0, previewSubmissionCount) : items;
	const obscuredItems = isCollapsed ? items.slice(previewSubmissionCount) : [];

	useEffect(() => setFilters(storedFilters()), []);

	const changeFilters = (next: SubmissionFilter[]) => {
		storeFilters(next);
		setSwitching(true);
		setFilters(next);
	};

	useEffect(() => {
		filtersRef.current = filters;
		if (!filters) return;
		let cancelled = false;
		let first = true;
		const refreshNewest = async () => {
			try {
				const page = await fetchPage(filters);
				if (cancelled) return;
				setNewest(page.items);
				setCounts(page.counts);
				// Only the first load of a choice of chips decides where its older pages
				// start; refreshes must not reset paging.
				if (first) {
					first = false;
					setOlder([]);
					setNextCursor(page.nextCursor ?? null);
					setSwitching(false);
				}
			} catch (err) {
				console.error("Failed to fetch submissions:", err);
			} finally {
				if (!cancelled) setLoading(false);
			}
		};

		// A hidden tab is not refreshed; it catches up the moment it is shown again.
		const refreshVisible = () => {
			if (document.visibilityState === "visible") void refreshNewest();
		};
		void refreshNewest();
		const interval = setInterval(refreshVisible, 5000);
		document.addEventListener("visibilitychange", refreshVisible);
		return () => {
			cancelled = true;
			clearInterval(interval);
			document.removeEventListener("visibilitychange", refreshVisible);
		};
	}, [filters]);

	const loadOlder = useCallback(async () => {
		if (!filters || !nextCursor || loadingOlder || switching) return;
		setLoadingOlder(true);
		try {
			const page = await fetchPage(filters, nextCursor);
			// A page of the previous choice of chips arriving after a change is dropped.
			if (filtersRef.current !== filters) return;
			setOlder((current) => [...current, ...page.items]);
			setNextCursor(page.nextCursor ?? null);
		} catch (err) {
			console.error("Failed to fetch older submissions:", err);
		} finally {
			setLoadingOlder(false);
		}
	}, [filters, nextCursor, loadingOlder, switching]);

	useEffect(() => {
		const target = sentinel.current;
		if (!expanded || !target || !nextCursor) return;
		// Content follows the list, so a reader who jumps to the page end (End key,
		// scrollbar drag) passes the list's end without it ever intersecting.
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((entry) => entry.isIntersecting || entry.boundingClientRect.bottom < 0)) void loadOlder();
		}, { rootMargin: "600px 0px" });
		observer.observe(target);
		return () => observer.disconnect();
	}, [expanded, nextCursor, loadOlder]);

	const header = (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<h2 className="text-2xl font-semibold">Recent Submissions</h2>
			{filters && <SubmissionFilterChips filters={filters} counts={counts} onChange={changeFilters} />}
		</div>
	);

	if (!filters || (loading && items.length === 0)) {
		return (
			<div className="space-y-4">
				{header}
				<div className="text-center py-10 text-muted-foreground">Loading submissions...</div>
			</div>
		);
	}

	if (items.length === 0) {
		return (
			<div className="space-y-4">
				{header}
				<div className="rounded-xl border border-dashed py-10 text-center text-muted-foreground">
					{switching ? "Loading submissions..." : filters.length ? "No submissions match these filters." : "Pick a status to list its submissions."}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{header}
			<div id="recent-submissions-list" aria-busy={switching} className={cn("transition-opacity duration-200", switching && "opacity-50")}>
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{visibleItems.map((item) => <ListTile key={item.key} item={item} />)}
				</div>

				{isCollapsed && (
					<div className="relative mt-4 h-24 overflow-hidden">
						<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							{obscuredItems.map((item) => <ListTile key={item.key} item={item} obscured />)}
						</div>

						<div className="pointer-events-none absolute inset-0 z-10 flex items-end justify-center bg-gradient-to-t from-background via-background/90 to-transparent pb-4">
							<Button
								type="button"
								variant="outline"
								size="icon"
								className="pointer-events-auto rounded-full shadow-md"
								aria-label="Show all recent submissions"
								aria-controls="recent-submissions-list"
								aria-expanded={false}
								title="Show all recent submissions"
								onClick={() => setExpanded(true)}
							>
								<ChevronDown />
							</Button>
						</div>
					</div>
				)}
			</div>

			{expanded && nextCursor && (
				<div ref={sentinel} className="py-6 text-center text-sm text-muted-foreground" aria-live="polite">
					{loadingOlder ? "Loading older submissions..." : ""}
				</div>
			)}

			{hasMoreSubmissions && expanded && (
				<div className="mt-4 flex justify-center">
					<Button
						type="button"
						variant="outline"
						size="icon"
						className="rounded-full"
						aria-label="Collapse recent submissions"
						aria-controls="recent-submissions-list"
						aria-expanded={true}
						title="Collapse recent submissions"
						onClick={() => setExpanded(false)}
					>
						<ChevronUp />
					</Button>
				</div>
			)}
		</div>
	);
}

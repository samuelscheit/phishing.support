"use client";

import { SubmissionFilterChips } from "@/components/SubmissionFilterChips";
import { SubmissionStatus } from "@/components/SubmissionStatus";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/web_lib/util";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SUBMISSION_FILTERS, isSubmissionFilter, type SubmissionFilter } from "@/lib/submissions/filters";
import type { SubmissionCard as SubmissionCardData, SubmissionCardPage } from "@/lib/submissions/list";
import { groupByCampaign, type SubmissionListItem } from "@/lib/submissions/campaign_groups";
import { hostOf } from "@/lib/website/site";

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

function SubmissionCard({ submission, obscured = false }: { submission: SubmissionCardData; obscured?: boolean }) {
	return (
		<Link
			href={`/submissions/${submission.id}`}
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
						<SubmissionStatus status={submission.status} />

						<span className="text-xs text-muted-foreground whitespace-nowrap">
							{formatDistanceToNow(new Date(submission.createdAt), { addSuffix: true })}
						</span>
					</div>
					<CardTitle className="text-lg truncate min-w-0">{submission.title}</CardTitle>
				</CardContent>
			</Card>
		</Link>
	);
}

type ListItem = SubmissionListItem;


function CampaignCard({ item, obscured = false }: { item: Extract<ListItem, { type: "campaign" }>; obscured?: boolean }) {
	const hosts = [...new Set(item.titles.map(hostOf))];
	return (
		<Link
			href={`/campaigns/${item.campaignId}`}
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
						<span className="flex items-center gap-2">
							<SubmissionStatus status="reported" />
							{item.siteCount > 1 && <span className="text-xs text-muted-foreground">{item.siteCount} sites</span>}
						</span>
						<span className="text-xs text-muted-foreground whitespace-nowrap">
							{formatDistanceToNow(new Date(item.newest.createdAt), { addSuffix: true })}
						</span>
					</div>
					<CardTitle className="text-lg truncate min-w-0">{hosts[0]}</CardTitle>
				</CardContent>
			</Card>
		</Link>
	);
}

function ListTile({ item, obscured }: { item: ListItem; obscured?: boolean }) {
	return item.type === "campaign"
		? <CampaignCard item={item} obscured={obscured} />
		: <SubmissionCard submission={item.submission} obscured={obscured} />;
}

async function fetchPage(filters: readonly SubmissionFilter[], cursor?: string): Promise<SubmissionCardPage> {
	const query = new URLSearchParams({ status: filters.join(",") });
	if (cursor) query.set("cursor", cursor);
	const res = await fetch(`/api/submissions?${query}`);
	if (!res.ok) throw new Error(`Listing submissions failed with HTTP ${res.status}`);
	return res.json();
}

/** Newest page first, then older pages; a card refreshed on the newest page replaces its older copy. */
function mergePages(newest: SubmissionCardData[], older: SubmissionCardData[]): SubmissionCardData[] {
	const seen = new Set(newest.map(({ id }) => id));
	return [...newest, ...older.filter(({ id }) => !seen.has(id))];
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
	const [counts, setCounts] = useState<SubmissionCardPage["counts"]>();
	// Set while the cards on screen still belong to the previous choice of chips.
	const [switching, setSwitching] = useState(false);
	const filtersRef = useRef(filters);
	const [newest, setNewest] = useState<SubmissionCardData[]>([]);
	const [older, setOlder] = useState<SubmissionCardData[]>([]);
	// `undefined` until the first page arrives; `null` once every page is loaded.
	const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [loading, setLoading] = useState(true);
	const [expanded, setExpanded] = useState(false);
	const sentinel = useRef<HTMLDivElement>(null);
	const submissions = mergePages(newest, older);
	const items = groupByCampaign(submissions);
	const columnCount = useGridColumnCount();
	const previewSubmissionCount = columnCount * PREVIEW_ROWS;
	const hasMoreSubmissions = items.length > previewSubmissionCount;
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
				setNewest(page.submissions);
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

		refreshNewest();
		const interval = setInterval(refreshNewest, 5000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [filters]);

	const loadOlder = useCallback(async () => {
		if (!filters || !nextCursor || loadingOlder || switching) return;
		setLoadingOlder(true);
		try {
			const page = await fetchPage(filters, nextCursor);
			// A page of the previous choice of chips arriving after a change is dropped.
			if (filtersRef.current !== filters) return;
			setOlder((current) => [...current, ...page.submissions]);
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

	if (!filters || (loading && submissions.length === 0)) {
		return (
			<div className="space-y-4">
				{header}
				<div className="text-center py-10 text-muted-foreground">Loading submissions...</div>
			</div>
		);
	}

	if (submissions.length === 0) {
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

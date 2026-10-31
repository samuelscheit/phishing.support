"use client";

import { SubmissionStatus } from "@/components/SubmissionStatus";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/web_lib/util";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SubmissionCard as SubmissionCardData, SubmissionCardPage } from "@/lib/submissions/list";

const PREVIEW_ROWS = 3;

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

async function fetchPage(cursor?: string): Promise<SubmissionCardPage> {
	const res = await fetch(cursor ? `/api/submissions?cursor=${encodeURIComponent(cursor)}` : "/api/submissions");
	if (!res.ok) throw new Error(`Listing submissions failed with HTTP ${res.status}`);
	return res.json();
}

/** Newest page first, then older pages; a card refreshed on the newest page replaces its older copy. */
function mergePages(newest: SubmissionCardData[], older: SubmissionCardData[]): SubmissionCardData[] {
	const seen = new Set(newest.map(({ id }) => id));
	return [...newest, ...older.filter(({ id }) => !seen.has(id))];
}

/**
 * Recent submissions: the newest page refreshes every five seconds, and once
 * expanded, older pages load as the reader scrolls to the end of the list.
 */
export function SubmissionsList() {
	const [newest, setNewest] = useState<SubmissionCardData[]>([]);
	const [older, setOlder] = useState<SubmissionCardData[]>([]);
	// `undefined` until the first page arrives; `null` once every page is loaded.
	const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [loading, setLoading] = useState(true);
	const [expanded, setExpanded] = useState(false);
	const sentinel = useRef<HTMLDivElement>(null);
	const submissions = mergePages(newest, older);
	const columnCount = useGridColumnCount();
	const previewSubmissionCount = columnCount * PREVIEW_ROWS;
	const hasMoreSubmissions = submissions.length > previewSubmissionCount;
	const isCollapsed = hasMoreSubmissions && !expanded;
	const visibleSubmissions = isCollapsed ? submissions.slice(0, previewSubmissionCount) : submissions;
	const obscuredSubmissions = isCollapsed ? submissions.slice(previewSubmissionCount) : [];

	useEffect(() => {
		const refreshNewest = async () => {
			try {
				const page = await fetchPage();
				setNewest(page.submissions);
				// Only the first load decides where older pages start; refreshes must not reset paging.
				setNextCursor((current) => current === undefined ? page.nextCursor ?? null : current);
			} catch (err) {
				console.error("Failed to fetch submissions:", err);
			} finally {
				setLoading(false);
			}
		};

		refreshNewest();
		const interval = setInterval(refreshNewest, 5000);
		return () => clearInterval(interval);
	}, []);

	const loadOlder = useCallback(async () => {
		if (!nextCursor || loadingOlder) return;
		setLoadingOlder(true);
		try {
			const page = await fetchPage(nextCursor);
			setOlder((current) => [...current, ...page.submissions]);
			setNextCursor(page.nextCursor ?? null);
		} catch (err) {
			console.error("Failed to fetch older submissions:", err);
		} finally {
			setLoadingOlder(false);
		}
	}, [nextCursor, loadingOlder]);

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

	if (loading && submissions.length === 0) {
		return <div className="text-center py-10 text-muted-foreground">Loading submissions...</div>;
	}

	if (submissions.length === 0) {
		return <div className="text-center py-10 text-muted-foreground">No submissions found.</div>;
	}

	return (
		<div>
			<div id="recent-submissions-list">
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{visibleSubmissions.map((submission) => (
						<SubmissionCard key={submission.id} submission={submission} />
					))}
				</div>

				{isCollapsed && (
					<div className="relative mt-4 h-24 overflow-hidden">
						<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
							{obscuredSubmissions.map((submission) => (
								<SubmissionCard key={submission.id} submission={submission} obscured />
							))}
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

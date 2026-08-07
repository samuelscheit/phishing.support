"use client";

import { SubmissionStatus } from "@/components/SubmissionStatus";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/web_lib/util";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Submission } from "../lib/db/schema";

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

function SubmissionCard({ submission, obscured = false }: { submission: Submission; obscured?: boolean }) {
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
					<CardTitle className="text-lg truncate min-w-0">
						{submission.data?.kind === "email"
							? submission.data.email?.subject || submission.dedupeKey
							: submission.data.website.url}
					</CardTitle>
				</CardContent>
			</Card>
		</Link>
	);
}

export function SubmissionsList() {
	const [submissions, setSubmissions] = useState<Submission[]>([]);
	const [loading, setLoading] = useState(true);
	const [expanded, setExpanded] = useState(false);
	const columnCount = useGridColumnCount();
	const previewSubmissionCount = columnCount * PREVIEW_ROWS;
	const hasMoreSubmissions = submissions.length > previewSubmissionCount;
	const isCollapsed = hasMoreSubmissions && !expanded;
	const visibleSubmissions = isCollapsed ? submissions.slice(0, previewSubmissionCount) : submissions;
	const obscuredSubmissions = isCollapsed ? submissions.slice(previewSubmissionCount) : [];

	useEffect(() => {
		const fetchSubmissions = async () => {
			try {
				const res = await fetch("/api/submissions");
				if (res.ok) {
					const data = await res.json();
					setSubmissions(data);
				}
			} catch (err) {
				console.error("Failed to fetch submissions:", err);
			} finally {
				setLoading(false);
			}
		};

		fetchSubmissions();
		const interval = setInterval(fetchSubmissions, 5000);
		return () => clearInterval(interval);
	}, []);

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

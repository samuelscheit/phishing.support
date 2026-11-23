"use client";

import { cn } from "@/lib/util/cn";
import { DEFAULT_SUBMISSION_FILTERS, SUBMISSION_FILTER_NAMES, type SubmissionFilter } from "@/lib/submissions/filters";

/** Each chip in the colors of the status badge its submissions show. */
const CHIPS: Record<SubmissionFilter, { label: string; on: string; dot: string }> = {
	running: { label: "Running", on: "border-blue-200 bg-blue-50 text-blue-700", dot: "bg-blue-500 motion-safe:animate-pulse" },
	phishing: { label: "Phishing", on: "border-red-200 bg-red-50 text-red-700", dot: "bg-red-500" },
	not_phishing: { label: "Not phishing", on: "border-emerald-200 bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
	failed: { label: "Failed", on: "border-zinc-300 bg-zinc-100 text-zinc-700", dot: "bg-zinc-500" },
};

function isDefaultSubmissionFilters(filters: readonly SubmissionFilter[]): boolean {
	return filters.length === DEFAULT_SUBMISSION_FILTERS.length && DEFAULT_SUBMISSION_FILTERS.every((name) => filters.includes(name));
}

/** Toggle chips, one per status group, each with how many submissions it holds. */
export function SubmissionFilterChips({ filters, counts, onChange }: {
	filters: readonly SubmissionFilter[];
	counts?: Record<SubmissionFilter, number>;
	onChange: (filters: SubmissionFilter[]) => void;
}) {
	const toggle = (name: SubmissionFilter) =>
		onChange(SUBMISSION_FILTER_NAMES.filter((other) => (other === name ? !filters.includes(name) : filters.includes(other))));

	return (
		<div role="group" aria-label="Filter submissions by status" className="flex flex-wrap items-center gap-1.5">
			{/* Before the chips: the row is right-aligned, so showing it never moves a chip from under the pointer. */}
			{!isDefaultSubmissionFilters(filters) && (
				<button
					type="button"
					onClick={() => onChange([...DEFAULT_SUBMISSION_FILTERS])}
					className="px-1.5 text-xs font-medium text-muted-foreground underline underline-offset-4 hover:text-foreground"
				>
					Reset
				</button>
			)}
			{SUBMISSION_FILTER_NAMES.map((name) => {
				const chip = CHIPS[name];
				const on = filters.includes(name);
				const count = counts?.[name];
				return (
					<button
						key={name}
						type="button"
						aria-pressed={on}
						onClick={() => toggle(name)}
						className={cn(
							"inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							on ? chip.on : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
						)}
					>
						<span aria-hidden className={cn("size-1.5 rounded-full", on ? chip.dot : "bg-current opacity-50")} />
						{chip.label}
						{count !== undefined && <span className="text-xs tabular-nums opacity-70">{count.toLocaleString("en-US")}</span>}
					</button>
				);
			})}
		</div>
	);
}

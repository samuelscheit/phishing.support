"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/util/cn";
import { CheckCircle2, Clock, Loader2, ShieldAlert, XCircle } from "lucide-react";
import type { ReportedAs } from "@/lib/submissions/finding";
import type { VisitQueueState } from "@/lib/website/visit_queue/position";

const REPORTED_AS_LABELS: Record<ReportedAs, string> = {
	phishing: "Phishing",
	malware: "Malware",
	phishing_and_malware: "Phishing & malware",
	deceptive_funnel: "Deceptive funnel",
};

/**
 * The badge text of a status: a reported case by what it was reported for
 * (`reportedAs`), "Reported" when that is unknown; a case that found nothing
 * reportable "No threat found", since its verdict covers malware as well as
 * phishing.
 */
export function submissionStatusLabel(status: string | null | undefined, reportedAs?: ReportedAs, queue?: VisitQueueState): string {
	const raw = (status || "").trim();
	const key = raw.toLowerCase();
	if (key === "reported") return reportedAs ? REPORTED_AS_LABELS[reportedAs] : "Reported";
	if (key === "invalid") return "No threat found";
	if (key === "queued") return queue?.kind === "queued" ? `Queued · #${queue.position}` : queue?.kind === "waiting" ? "Waiting" : "Queued";
	return raw || "Unknown";
}

/** A case's status as a badge, labelled by `submissionStatusLabel`; a queued case's with its place in the visit queue. */
export function SubmissionStatus({ status, reportedAs, queue, className }: { status?: string | null; reportedAs?: ReportedAs; queue?: VisitQueueState; className?: string }) {
	const raw = (status || "").trim();
	const key = raw.toLowerCase();

	if (key === "queued") {
		return (
			<Badge variant="outline" className={cn("gap-1 border-slate-200 bg-slate-50 text-slate-700", className)}>
				<Clock className="h-3.5 w-3.5" />
				{submissionStatusLabel(status, reportedAs, queue)}
			</Badge>
		);
	}

	const isPending = key === "running";
	const isReported = key === "reported";
	const isInvalid = key === "invalid";
	const isFailed = key === "failed";
	const isCompleted = key === "completed";

	const label = submissionStatusLabel(status, reportedAs);

	if (isReported) {
		return (
			<Badge variant="destructive" className={cn("gap-1", className)}>
				<ShieldAlert className="h-3.5 w-3.5" />
				{label}
			</Badge>
		);
	}

	if (isInvalid) {
		return (
			<Badge variant="outline" className={cn("gap-1 border-emerald-200 bg-emerald-50 text-emerald-700", className)}>
				<CheckCircle2 className="h-3.5 w-3.5" />
				{label}
			</Badge>
		);
	}

	if (isPending) {
		return (
			<Badge variant="outline" className={cn("gap-1 text-blue-700 border-blue-200 bg-blue-50 capitalize", className)}>
				<Loader2 className="h-3.5 w-3.5 animate-spin" />
				{raw || "pending"}
			</Badge>
		);
	}

	// A failed analysis says nothing about the site; it is not an alarm.
	if (isFailed) {
		return (
			<Badge variant="outline" className={cn("gap-1 capitalize border-gray-200 bg-gray-50 text-gray-600", className)}>
				<XCircle className="h-3.5 w-3.5" />
				{raw || "failed"}
			</Badge>
		);
	}

	return (
		<Badge variant={isCompleted ? "default" : "outline"} className={cn("capitalize", className)}>
			{raw || "unknown"}
		</Badge>
	);
}

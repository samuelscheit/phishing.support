"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/web_lib/util";
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from "lucide-react";

export function SubmissionStatus({ status, className }: { status?: string | null; className?: string }) {
	const raw = (status || "").trim();
	const key = raw.toLowerCase();

	const isPending = key === "new" || key === "queued" || key === "running";
	const isReported = key === "reported";
	const isInvalid = key === "invalid";
	const isFailed = key === "failed";
	const isCompleted = key === "completed";

	const label = isReported ? "Report submitted" : isInvalid ? "Not phishing" : raw || "Unknown";

	const dotClass = isReported
		? "bg-red-500"
		: isInvalid
			? "bg-emerald-500"
			: isFailed
				? "bg-red-500"
				: isCompleted
					? "bg-green-500"
					: isPending
						? "bg-blue-500"
						: "bg-yellow-500";

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

	if (isFailed) {
		return (
			<Badge variant="destructive" className={cn("gap-1 capitalize", className)}>
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

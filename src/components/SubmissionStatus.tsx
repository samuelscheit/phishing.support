"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/web_lib/util";
import { CheckCircle2, CornerDownRight, Loader2, ShieldAlert, XCircle } from "lucide-react";

export function SubmissionStatus({ status, className }: { status?: string | null; className?: string }) {
	const raw = (status || "").trim();
	const key = raw.toLowerCase();

	const isPending = key === "new" || key === "queued" || key === "running";
	const isReported = key === "reported";
	const isInvalid = key === "invalid";
	const isFailed = key === "failed";
	const isCompleted = key === "completed";
	const isRedirected = key === "redirected";

	const label = isReported ? "Phishing" : isInvalid ? "Not phishing" : raw || "Unknown";

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

	if (isRedirected) {
		return (
			<Badge variant="outline" className={cn("gap-1 border-amber-200 bg-amber-50 text-amber-800", className)}>
				<CornerDownRight className="h-3.5 w-3.5" />
				Redirects
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

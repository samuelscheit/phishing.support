"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type RouteStatus = {
	provider: string;
	routeType: string;
	status: string;
	confirmationId?: string;
	error?: string;
};

type ReportStatus = {
	status: string;
	createdAt: string;
	updatedAt: string;
	targets: Array<{
		target: string;
		type: string;
		status: string;
		disposition?: string;
		providerRoutes: RouteStatus[];
	}>;
};

const statusText: Record<string, string> = {
	accepted: "Accepted and queued",
	resolving: "Resolving provider contacts",
	verifying: "Verifying evidence",
	queued: "Queued for provider submission",
	running: "Submitting automatically",
	waiting_provider: "Waiting for provider reply",
	partially_submitted: "Partially submitted",
	submitted: "Submitted or acknowledged",
	insufficient_evidence: "Insufficient evidence for an automatic route",
	no_route: "No verified abuse route",
	failed: "Could not complete safely",
	needs_human: "Provider form needs a safety review",
	canceled: "Canceled",
};

const routeText: Record<string, string> = {
	verified: "Verified route",
	queued: "Queued",
	running: "Running",
	waiting_code: "Waiting for provider code",
	submitted: "Submitted",
	awaiting_provider_reply: "Awaiting provider reply",
	acknowledged: "Provider acknowledged",
	provider_rejected: "Provider rejected",
	delivery_failed: "Delivery failed",
	insufficient_evidence: "Insufficient evidence",
	no_route: "No route",
	needs_human: "Safety review required",
	unknown_external_state: "External state needs reconciliation",
	failed: "Failed safely",
};

function displayStatus(value: string, map: Record<string, string>): string {
	return map[value] ?? value.replaceAll("_", " ");
}

export function AbuseStatusClient({ trackingToken }: { trackingToken: string }) {
	const [report, setReport] = useState<ReportStatus>();
	const [error, setError] = useState<string>();

	useEffect(() => {
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const load = async () => {
			try {
				const response = await fetch(`/api/abuse/reports/${encodeURIComponent(trackingToken)}`, { cache: "no-store" });
				const value = (await response.json().catch(() => ({}))) as ReportStatus & { error?: string };
				if (!response.ok) throw new Error(value.error || "This report could not be found.");
				if (active) {
					setReport(value);
					setError(undefined);
					timer = setTimeout(load, 5_000);
				}
			} catch (loadError) {
				if (active) {
					setError(loadError instanceof Error ? loadError.message : "Status is temporarily unavailable.");
					timer = setTimeout(load, 10_000);
				}
			}
		};
		void load();
		return () => {
			active = false;
			if (timer) clearTimeout(timer);
		};
	}, [trackingToken]);

	return (
		<div className="space-y-8">
			<div className="rounded-2xl border bg-card p-6 shadow-sm">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<p className="text-sm font-medium text-muted-foreground">Private report status</p>
						<h1 className="mt-1 text-3xl font-semibold">{report ? displayStatus(report.status, statusText) : "Loading status…"}</h1>
					</div>
					<span className="rounded-full bg-muted px-3 py-1 text-sm">Updates automatically</span>
				</div>
				{report && <p className="mt-4 text-sm text-muted-foreground">Last updated {new Date(report.updatedAt).toLocaleString()}</p>}
			</div>

			{error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-900">{error}</p>}

			{report && (
				<div className="space-y-4">
					{report.targets.map((target) => (
						<section key={`${target.type}:${target.target}`} className="rounded-2xl border bg-card p-6 shadow-sm">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div>
									<h2 className="font-mono text-lg font-semibold">{target.target}</h2>
									<p className="text-sm text-muted-foreground">{target.type} · {displayStatus(target.status, statusText)}</p>
								</div>
								{target.disposition && <p className="max-w-md text-sm text-muted-foreground">{target.disposition}</p>}
							</div>
							{target.providerRoutes.length > 0 ? (
								<ul className="mt-5 space-y-3">
									{target.providerRoutes.map((route) => (
										<li key={`${route.provider}:${route.routeType}`} className="rounded-lg border p-4">
											<div className="flex flex-wrap justify-between gap-2">
												<span className="font-medium">{route.provider}</span>
												<span className="text-sm text-muted-foreground">{displayStatus(route.status, routeText)}</span>
											</div>
											<p className="mt-1 text-xs text-muted-foreground">{route.routeType}</p>
											{route.confirmationId && <p className="mt-2 text-sm">Confirmation: <span className="font-mono">{route.confirmationId}</span></p>}
											{route.error && <p className="mt-2 text-sm text-muted-foreground">{route.error}</p>}
										</li>
									))}
								</ul>
							) : <p className="mt-5 text-sm text-muted-foreground">Provider resolution is still pending.</p>}
						</section>
					))}
				</div>
			)}

			<div className="text-center text-sm text-muted-foreground"><Link href="/abuse-reporting" className="underline hover:text-foreground">Submit another abuse report</Link></div>
		</div>
	);
}

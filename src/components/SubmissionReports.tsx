"use client";

import { useState } from "react";
import { Bell, Check, Copy, Download, ExternalLink, Mail, MessageSquareReply, OctagonAlert, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SubmissionReport, SubmissionReportArtifact, SubmissionReportMessage, SubmissionReportRoute } from "@/lib/submissions/details";
import { describeProviderReportStatus } from "@/lib/abuse/provider_status";
import { formatUtcDateTime } from "@/lib/date_time";
import { cn } from "@/web_lib/util";

type DateValue = Date | string | number | null | undefined;

function formatDate(value: DateValue): string {
	return formatUtcDateTime(value) ?? "Unknown time";
}

function label(value: string): string {
	return value.replaceAll("_", " ");
}

function statusClass(status: string) {
	if (["sent", "submitted", "acknowledged", "received"].includes(status)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
	if (["delivery_failed", "failed", "provider_rejected", "unknown_external_state", "needs_human", "insufficient_evidence", "no_route"].includes(status)) return "border-red-200 bg-red-50 text-red-800";
	if (["pending", "queued", "running", "verified", "resolving", "accepted", "verifying"].includes(status)) return "border-amber-200 bg-amber-50 text-amber-800";
	return "border-blue-200 bg-blue-50 text-blue-800";
}

const reportStatusText: Record<string, string> = {
	accepted: "The report was accepted and its provider routes are being resolved.",
	resolving: "Abuse contacts and infrastructure routes are being resolved.",
	verifying: "Resolved provider routes are being verified.",
	queued: "Provider reports are queued for submission.",
	running: "Provider reports are being submitted.",
	waiting_provider: "Reports were delivered; waiting for provider responses.",
	partially_submitted: "Some providers confirmed the report; the remaining routes did not.",
	submitted: "Every provider route confirmed the report.",
	insufficient_evidence: "The evidence did not satisfy any provider's submission requirements.",
	no_route: "No abuse contact or provider route was found.",
	failed: "No provider route confirmed the report.",
	needs_human: "A provider route needs manual review.",
	canceled: "The report was canceled.",
};

function ArtifactLink({ submissionId, artifact, fallback }: { submissionId: string; artifact?: SubmissionReportArtifact; fallback: string }) {
	if (!artifact) return null;
	return (
		<a href={`/api/submissions/${submissionId}/report-artifacts/${artifact.id}`} className="inline-flex max-w-full items-center gap-1 break-all text-xs text-primary hover:underline">
			<Download className="h-3.5 w-3.5 shrink-0" />
			{artifact.name || fallback}
		</a>
	);
}

function CopyReplyAddress({ replyAddress }: { replyAddress: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(replyAddress);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1_800);
		} catch {
			setCopied(false);
		}
	};
	return (
		<button type="button" onClick={copy} title="Copy generated reply address" className="inline-flex max-w-full items-center gap-1 rounded border px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-muted">
			<span className="truncate">{replyAddress}</span>
			{copied ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 shrink-0" />}
		</button>
	);
}

/** What each stored message is, as the case timeline shows it. */
function messageTitle(message: SubmissionReportMessage): string {
	if (message.direction === "outbound") return "Report sent";
	if (message.kind === "bounce" || message.classification === "bounce") return "Delivery failed";
	if (message.kind === "notification") return "Provider update";
	if (message.kind === "provider_api") return "Provider message";
	return "Reply received";
}

function MessageItem({ submissionId, message, artifacts }: { submissionId: string; message: SubmissionReportMessage; artifacts: Map<string, SubmissionReportArtifact> }) {
	const outbound = message.direction === "outbound";
	const bounce = message.kind === "bounce" || message.classification === "bounce";
	const update = message.kind === "notification" || message.kind === "provider_api";
	return (
		<div className={cn("relative border-l-2 pb-6 pl-4 last:pb-0", bounce ? "border-red-300" : "border-muted")}>
			<div className="absolute -left-[9px] top-0 grid h-4 w-4 place-items-center rounded-full bg-background">
				{bounce ? <OctagonAlert className="h-4 w-4 text-red-700" /> : outbound ? <Send className="h-4 w-4 text-blue-700" /> : update ? <Bell className="h-4 w-4 text-slate-600" /> : <MessageSquareReply className="h-4 w-4 text-emerald-700" />}
			</div>
			<div className={cn("rounded-md border p-3", bounce ? "border-red-200 bg-red-50/60" : "bg-muted/20")}>
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="secondary">{messageTitle(message)}</Badge>
						{outbound ? <Badge variant="outline" className={cn("capitalize", statusClass(message.status))}>{label(message.status)}</Badge> : null}
						{message.classification && !update && !bounce ? <Badge variant="outline" className="capitalize">{label(message.classification)}</Badge> : null}
					</div>
					<div className="text-xs text-muted-foreground">{formatDate(message.occurredAt)}</div>
				</div>
				<div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
					<div><span className="text-muted-foreground">From:</span> <span className="break-all">{message.fromAddress || "—"}</span></div>
					<div><span className="text-muted-foreground">To:</span> <span className="break-all">{message.toAddresses.join(", ") || "—"}</span></div>
					{message.messageId ? <div className="sm:col-span-2"><span className="text-muted-foreground">Message-ID:</span> <span className="break-all font-mono">{message.messageId}</span></div> : null}
				</div>
				{message.subject ? <div className="mt-3 text-sm"><span className="text-muted-foreground">Subject:</span> {message.subject}</div> : null}
				{message.textBody ? <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-3 font-sans text-sm">{message.textBody}</pre> : null}
				{outbound && message.replyAddress ? <div className="mt-3 space-y-1 text-xs"><div className="text-muted-foreground">Generated Reply-To</div><CopyReplyAddress replyAddress={message.replyAddress} /></div> : null}
				<div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
					<ArtifactLink submissionId={submissionId} artifact={message.rawArtifactId ? artifacts.get(String(message.rawArtifactId)) : undefined} fallback="Raw message (.eml)" />
					{message.attachmentArtifactIds.map((id, index) => <ArtifactLink key={id} submissionId={submissionId} artifact={artifacts.get(String(id))} fallback={`Attachment ${index + 1}`} />)}
				</div>
			</div>
		</div>
	);
}

function RouteCard({ submissionId, route, artifacts }: { submissionId: string; route: SubmissionReportRoute; artifacts: Map<string, SubmissionReportArtifact> }) {
	const confirmed = route.status === "submitted" || route.status === "acknowledged";
	const failed = ["unknown_external_state", "provider_rejected", "failed", "delivery_failed", "needs_human", "insufficient_evidence", "no_route"].includes(route.status);
	const mail = route.routeType === "email";
	return (
		<Card className="overflow-hidden">
			<CardHeader className="border-b bg-muted/20 py-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0 space-y-1">
						<CardTitle className="flex items-center gap-2 text-base">{mail ? <Mail className="h-4 w-4 shrink-0" /> : <Send className="h-4 w-4 shrink-0" />} {route.provider}</CardTitle>
						<CardDescription className="break-all">{mail ? "Abuse email" : "Direct provider submission"} • target: {route.target}</CardDescription>
					</div>
					<Badge variant="outline" className={cn("capitalize", statusClass(route.status))}>{label(route.status)}</Badge>
				</div>
				<div className="grid gap-3 pt-2 text-xs sm:grid-cols-2">
					<div><span className="text-muted-foreground">Prepared:</span> {formatDate(route.createdAt)}</div>
					<div><span className="text-muted-foreground">Last update:</span> {formatDate(route.updatedAt)}</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-3 p-4">
				<div className={cn("rounded-md border p-3 text-sm", confirmed ? "border-emerald-200 bg-emerald-50 text-emerald-900" : failed ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900")}>
					{describeProviderReportStatus(route)}
				</div>
				{route.observedUrls.length ? <div className="text-xs"><div className="mb-1 text-muted-foreground">Reported URL{route.observedUrls.length === 1 ? "" : "s"}</div><div className="space-y-1 break-all font-mono">{route.observedUrls.map((url) => <div key={url}>{url}</div>)}</div></div> : null}
				{route.confirmationId ? <div className="text-xs"><span className="text-muted-foreground">Confirmation:</span> <span className="break-all font-mono">{route.confirmationId}</span></div> : null}
				{route.confirmationText ? <div className="text-sm"><span className="text-muted-foreground">Provider response:</span> {route.confirmationText}</div> : null}
				{route.body ? (
					<details className="rounded border bg-muted/10 p-3">
						<summary className="cursor-pointer text-sm font-medium">{route.bodySource === "prepared" ? "View submitted report" : route.bodySource === "historical" ? "View historical report" : "View report draft preview"}</summary>
						{route.bodySource === "preview" ? <div className="mt-2 text-xs text-muted-foreground">This draft is generated for this provider and pinned when submission starts.</div> : null}
						<pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{route.body}</pre>
					</details>
				) : null}
				{route.messages.length ? <div>{route.messages.map((message) => <MessageItem key={String(message.id)} submissionId={submissionId} message={message} artifacts={artifacts} />)}</div> : null}
				{route.finalUrl ? <a href={route.finalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Open provider confirmation</a> : null}
			</CardContent>
		</Card>
	);
}

/** Reports tab: the submission's report with one card per provider route. */
export function SubmissionReports({ submissionId, report }: { submissionId: string; report: SubmissionReport | null }) {
	if (!report) return <div className="py-10 text-center text-muted-foreground">No reports yet.</div>;
	const artifacts = new Map(report.artifacts.map((artifact) => [String(artifact.id), artifact]));
	const evidence = report.artifacts.filter((artifact) => artifact.kind === "user_evidence_original");
	return (
		<div className="space-y-5">
			<Card>
				<CardContent className="space-y-3 p-4">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<CardTitle className="text-base">Abuse report</CardTitle>
						<Badge variant="outline" className={cn("capitalize", statusClass(report.status))}>{label(report.status)}</Badge>
					</div>
					<p className="text-sm text-muted-foreground">{reportStatusText[report.status] ?? `Report status: ${label(report.status)}.`}</p>
					<div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
						<div>Accepted: {formatDate(report.createdAt)}</div>
						<div>Last update: {formatDate(report.updatedAt)}</div>
					</div>
					{evidence.length ? <div className="flex flex-wrap gap-x-4 gap-y-2"><span className="text-xs text-muted-foreground">Evidence:</span>{evidence.map((artifact) => <ArtifactLink key={String(artifact.id)} submissionId={submissionId} artifact={artifact} fallback="Evidence" />)}</div> : null}
				</CardContent>
			</Card>
			{report.routes.map((route) => <RouteCard key={String(route.id)} submissionId={submissionId} route={route} artifacts={artifacts} />)}
		</div>
	);
}

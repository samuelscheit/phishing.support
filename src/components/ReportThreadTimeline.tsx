"use client";

import { useMemo, useState } from "react";
import { format } from "date-fns";
import { Check, Copy, Download, ExternalLink, Mail, MessageSquareReply, OctagonAlert, Send, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
	SubmissionAbuseMailReport,
	SubmissionAbuseProviderReport,
	SubmissionArtifact,
	SubmissionProviderReport,
	SubmissionReportMessage,
	SubmissionReportThread,
} from "@/lib/submissions/details";
import { describeProviderReportStatus } from "@/lib/abuse/provider_status";
import { cn } from "@/web_lib/util";

type DateValue = Date | string | number | null | undefined;
type ArtifactReference = bigint | string | null | undefined;

export type ReportThreadWithMessages = SubmissionReportThread;

function asKey(value: ArtifactReference): string | undefined {
	return value === null || value === undefined ? undefined : String(value);
}

function formatDate(value: DateValue): string {
	if (!value) return "Unknown time";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "Unknown time" : format(date, "PPP p");
}

function formatAddresses(addresses: string[] | null | undefined): string {
	return addresses?.filter(Boolean).join(", ") || "—";
}

function statusClass(status: string) {
	if (["replied", "sent", "submitted", "acknowledged"].includes(status)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
	if (["delivery_failed", "failed", "provider_rejected", "unknown_external_state", "needs_human"].includes(status)) return "border-red-200 bg-red-50 text-red-800";
	if (["pending", "queued", "running", "verified", "submission_started"].includes(status)) return "border-amber-200 bg-amber-50 text-amber-800";
	return "border-blue-200 bg-blue-50 text-blue-800";
}

function kindIcon(message: SubmissionReportMessage) {
	if (message.kind === "bounce") return <OctagonAlert className="h-4 w-4 text-red-700" />;
	if (message.kind === "auto_reply") return <Undo2 className="h-4 w-4 text-amber-700" />;
	if (message.direction === "outbound") return <Send className="h-4 w-4 text-blue-700" />;
	return <MessageSquareReply className="h-4 w-4 text-emerald-700" />;
}

function kindLabel(message: SubmissionReportMessage) {
	if (message.kind === "bounce") return "Delivery failure";
	if (message.kind === "auto_reply") return "Automatic reply";
	if (message.direction === "outbound") return "Abuse report sent";
	return "Reply received";
}

function SafeHtml({ html, title }: { html: string; title: string }) {
	const document = useMemo(
		() => `<!doctype html><html><head><meta charset="utf-8" /><meta name="referrer" content="no-referrer" /></head><body>${html}</body></html>`,
		[html],
	);
	return <iframe title={title} srcDoc={document} sandbox="" referrerPolicy="no-referrer" className="mt-3 min-h-56 w-full rounded border bg-white" />;
}

function DownloadLink({ artifact, label, className }: { artifact?: SubmissionArtifact; label: string; className?: string }) {
	if (!artifact) return null;
	return (
		<a
			href={`/api/artifacts/${artifact.id}`}
			download={artifact.name ?? undefined}
			className={cn("inline-flex items-center gap-1 text-xs text-primary hover:underline", className)}
		>
			<Download className="h-3.5 w-3.5" />
			{label}
		</a>
	);
}

function AttachmentLinks({ ids, artifacts }: { ids: string[] | null | undefined; artifacts: Map<string, SubmissionArtifact> }) {
	if (!ids?.length) return null;
	return (
		<div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
			{ids.map((id, index) => {
				const artifact = artifacts.get(String(id));
				return (
					<DownloadLink
						key={`${id}-${index}`}
						artifact={artifact}
						label={artifact?.name || `Attachment ${index + 1}`}
						className="max-w-full break-all"
					/>
				);
			})}
		</div>
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
		<button
			type="button"
			onClick={copy}
			className="inline-flex max-w-full items-center gap-1 rounded border px-2 py-1 font-mono text-xs text-muted-foreground hover:bg-muted"
			title="Copy generated reply address"
		>
			<span className="truncate">{replyAddress}</span>
			{copied ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 shrink-0" />}
		</button>
	);
}

function MessageTimelineItem({ message, artifacts }: { message: SubmissionReportMessage; artifacts: Map<string, SubmissionArtifact> }) {
	const rawArtifact = artifacts.get(asKey(message.rawArtifactId) ?? "");
	const isFailure = message.kind === "bounce";
	const isAutomatic = message.kind === "auto_reply";

	return (
		<div className={cn("relative border-l-2 pl-4 pb-6 last:pb-0", isFailure ? "border-red-300" : isAutomatic ? "border-amber-300" : "border-muted") }>
			<div className={cn("absolute -left-[9px] top-0 grid h-4 w-4 place-items-center rounded-full bg-background", isFailure ? "text-red-700" : isAutomatic ? "text-amber-700" : "text-muted-foreground")}>
				{kindIcon(message)}
			</div>
			<div className={cn("rounded-md border p-3", isFailure ? "border-red-200 bg-red-50/60" : isAutomatic ? "border-amber-200 bg-amber-50/60" : "bg-muted/20")}>
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="outline" className="capitalize">{message.direction}</Badge>
						<Badge variant={isFailure ? "destructive" : "secondary"}>{kindLabel(message)}</Badge>
						<Badge variant="outline" className="capitalize">{message.status}</Badge>
					</div>
					<div className="text-xs text-muted-foreground">{formatDate(message.occurredAt)}</div>
				</div>

				{isFailure ? <div className="mt-3 text-sm font-medium text-red-800">This message is a delivery-status notification for this abuse report.</div> : null}
				{isAutomatic ? <div className="mt-3 text-sm font-medium text-amber-800">This message was identified as an automatic response.</div> : null}
				<div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
					<div><span className="text-muted-foreground">From:</span> <span className="break-all">{message.from || "—"}</span></div>
					<div><span className="text-muted-foreground">To:</span> <span className="break-all">{formatAddresses(message.to)}</span></div>
					{message.cc?.length ? <div><span className="text-muted-foreground">Cc:</span> <span className="break-all">{formatAddresses(message.cc)}</span></div> : null}
					{message.messageId ? <div><span className="text-muted-foreground">Message-ID:</span> <span className="break-all font-mono">{message.messageId}</span></div> : null}
					{message.inReplyTo ? <div><span className="text-muted-foreground">In-Reply-To:</span> <span className="break-all font-mono">{message.inReplyTo}</span></div> : null}
					{message.references?.length ? <div className="sm:col-span-2"><span className="text-muted-foreground">References:</span> <span className="break-all font-mono">{message.references.join(" ")}</span></div> : null}
				</div>
				{message.subject ? <div className="mt-3 text-sm"><span className="text-muted-foreground">Subject:</span> {message.subject}</div> : null}
				{message.textBody ? <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-3 font-sans text-sm">{message.textBody}</pre> : null}
				{message.htmlBody ? <SafeHtml html={message.htmlBody} title={`${kindLabel(message)} HTML`} /> : null}
				<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
					<DownloadLink artifact={rawArtifact} label="Download raw .eml" />
					<AttachmentLinks ids={message.attachmentArtifactIds} artifacts={artifacts} />
				</div>
			</div>
		</div>
	);
}

function StandaloneAbuseMailCard({ report }: { report: SubmissionAbuseMailReport }) {
	return (
		<Card className="overflow-hidden">
			<CardContent className="space-y-3 p-4">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<CardTitle className="flex items-center gap-2 text-base">
						<Mail className="h-4 w-4 shrink-0" />
						{report.provider}
					</CardTitle>
					<Badge variant={report.status === "failed" ? "destructive" : report.status === "pending" ? "outline" : "secondary"}>
						{report.status.replaceAll("_", " ")}
					</Badge>
				</div>
				<div className="text-xs text-muted-foreground">
					Standalone abuse email • {report.routeType.replaceAll("_", " ")} • target: {report.target} • {formatDate(report.occurredAt)}
				</div>
				<div className="grid gap-2 text-xs sm:grid-cols-2">
					<div><span className="text-muted-foreground">From:</span> <span className="break-all">{report.fromAddress || "—"}</span></div>
					<div><span className="text-muted-foreground">To:</span> <span className="break-all">{formatAddresses(report.toAddresses)}</span></div>
					{report.messageId ? <div className="sm:col-span-2"><span className="text-muted-foreground">Message-ID:</span> <span className="break-all font-mono">{report.messageId}</span></div> : null}
				</div>
				{report.subject ? <div className="text-sm"><span className="text-muted-foreground">Subject:</span> {report.subject}</div> : null}
				{report.textBody ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border bg-background p-3 font-sans text-sm">{report.textBody}</pre> : <div className="text-sm text-muted-foreground">No body recorded.</div>}
				{report.replyAddress ? <div className="space-y-1 text-xs"><div className="text-muted-foreground">Generated Reply-To</div><CopyReplyAddress replyAddress={report.replyAddress} /></div> : null}
			</CardContent>
		</Card>
	);
}

function StandaloneAbuseProviderCard({ report }: { report: SubmissionAbuseProviderReport }) {
	const submitted = report.status === "submitted" || report.status === "acknowledged";
	const unresolved = report.status === "unknown_external_state";
	const rejected = report.status === "provider_rejected";
	const statusDescription = describeProviderReportStatus(report);

	return (
		<Card className="overflow-hidden">
			<CardHeader className="border-b bg-muted/20 py-4">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0 space-y-1">
						<CardTitle className="flex items-center gap-2 text-base"><Send className="h-4 w-4 shrink-0" /> {report.provider}</CardTitle>
						<CardDescription>Direct provider submission • target: {report.target}</CardDescription>
					</div>
					<Badge variant="outline" className={cn("capitalize", statusClass(report.status))}>{report.status.replaceAll("_", " ")}</Badge>
				</div>
				<div className="grid gap-3 pt-2 text-xs sm:grid-cols-2">
					<div><span className="text-muted-foreground">Prepared:</span> {formatDate(report.createdAt)}</div>
					<div><span className="text-muted-foreground">Last update:</span> {formatDate(report.updatedAt)}</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-3 p-4">
				<div className={cn("rounded-md border p-3 text-sm", submitted ? "border-emerald-200 bg-emerald-50 text-emerald-900" : unresolved || rejected ? "border-red-200 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900")}>
					{statusDescription}
				</div>
				{report.executionStatus ? <div className="text-xs text-muted-foreground">Execution phase: <span className="font-medium capitalize">{report.executionStatus.replaceAll("_", " ")}</span></div> : null}
				{report.observedUrls.length ? <div className="text-xs"><div className="mb-1 text-muted-foreground">Reported URL{report.observedUrls.length === 1 ? "" : "s"}</div><div className="space-y-1 font-mono break-all">{report.observedUrls.map((url) => <div key={url}>{url}</div>)}</div></div> : null}
				{report.submittedTargets.length ? <div className="text-xs"><span className="text-muted-foreground">Provider-confirmed target{report.submittedTargets.length === 1 ? "" : "s"}:</span> <span className="break-all">{report.submittedTargets.join(", ")}</span></div> : null}
				{report.confirmationId ? <div className="text-xs"><span className="text-muted-foreground">Confirmation:</span> <span className="break-all font-mono">{report.confirmationId}</span></div> : null}
				{report.confirmationText ? <div className="text-sm"><span className="text-muted-foreground">Provider response:</span> {report.confirmationText}</div> : null}
				<details className="rounded border bg-muted/10 p-3">
					<summary className="cursor-pointer text-sm font-medium">{report.bodySource === "prepared" ? "View provider-specific report" : report.bodySource === "historical_legacy" ? "View provider-specific reference preview" : "View provider-specific draft preview"}</summary>
					{report.bodySource === "preview" ? <div className="mt-2 text-xs text-muted-foreground">This draft is generated for this provider and will be pinned when submission starts.</div> : null}
					{report.bodySource === "legacy_preview" ? <div className="mt-2 text-xs text-muted-foreground">An outdated analysis-derived draft was retained before submission. This provider-specific preview replaces it before the provider request can start.</div> : null}
					{report.bodySource === "historical_legacy" ? <div className="mt-2 text-xs text-muted-foreground">This historical provider run used an older analysis-derived payload. The provider-specific text shown here is a reference preview; the historical request cannot be rewritten without filing a new report.</div> : null}
					<pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{report.body}</pre>
				</details>
				{report.finalUrl ? <a href={report.finalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline"><ExternalLink className="h-3.5 w-3.5" /> Open provider confirmation</a> : null}
			</CardContent>
		</Card>
	);
}

export function ReportThreadTimeline({ threads, providerReports, abuseMailReports, abuseProviderReports, artifacts }: {
	threads: ReportThreadWithMessages[];
	providerReports: SubmissionProviderReport[];
	abuseMailReports: SubmissionAbuseMailReport[];
	abuseProviderReports: SubmissionAbuseProviderReport[];
	artifacts: SubmissionArtifact[];
}) {
	const artifactMap = useMemo(() => new Map(artifacts.map((artifact) => [String(artifact.id), artifact])), [artifacts]);

	if (threads.length === 0 && providerReports.length === 0 && abuseMailReports.length === 0 && abuseProviderReports.length === 0) {
		return <div className="py-10 text-center text-muted-foreground">No reports yet.</div>;
	}

	return (
		<div className="space-y-5">
			{threads.map((thread) => {
				const messages = [...thread.messages].sort((left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime());
				const sent = messages.find((message) => message.direction === "outbound");
				const sentAt = sent?.sentAt ?? sent?.occurredAt ?? thread.createdAt;
				const lastActivity = messages.at(-1)?.occurredAt ?? thread.updatedAt;
				return (
					<Card key={String(thread.id)} className="overflow-hidden">
						<CardHeader className="border-b bg-muted/20">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div className="min-w-0 space-y-1">
									<CardTitle className="flex items-center gap-2 text-base"><Mail className="h-4 w-4 shrink-0" /> SMTP abuse report</CardTitle>
									<CardDescription className="break-all">To: {formatAddresses(thread.to)}</CardDescription>
								</div>
								<Badge variant="outline" className={cn("capitalize", statusClass(thread.status))}>{thread.status.replaceAll("_", " ")}</Badge>
							</div>
							{thread.subject ? <div className="pt-2 text-sm"><span className="text-muted-foreground">Subject:</span> {thread.subject}</div> : null}
							<div className="grid gap-3 pt-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
								<div><span className="text-muted-foreground">{sent?.sentAt ? "Sent:" : "Created:"}</span> {formatDate(sentAt)}</div>
								<div><span className="text-muted-foreground">Last activity:</span> {formatDate(lastActivity)}</div>
								<div className="min-w-0 space-y-1"><div className="text-muted-foreground">Generated Reply-To</div><CopyReplyAddress replyAddress={thread.replyAddress} /></div>
							</div>
						</CardHeader>
						<CardContent className="p-4">
							{messages.length ? <div className="space-y-0">{messages.map((message) => <MessageTimelineItem key={String(message.id)} message={message} artifacts={artifactMap} />)}</div> : <div className="text-sm text-muted-foreground">The report thread has no stored messages yet.</div>}
						</CardContent>
					</Card>
				);
			})}

			{providerReports.map((report) => (
				<Card key={String(report.id)} className="overflow-hidden">
					<CardContent className="space-y-3 p-4">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<CardTitle className="text-base">{report.to}</CardTitle>
							<div className="flex gap-2"><Badge variant="outline">{report.legacy ? "Legacy/provider report" : "Provider report"}</Badge><Badge variant={report.status === "failed" || report.status === "unknown_external_state" ? "destructive" : report.status === "pending" || report.status === "submission_started" ? "outline" : "secondary"}>{report.status.replaceAll("_", " ")}</Badge></div>
						</div>
						<div className="text-xs text-muted-foreground">{report.channel} • {formatDate(report.sentAt ?? report.createdAt)}</div>
						{report.subject ? <div className="text-sm"><span className="text-muted-foreground">Subject:</span> {report.subject}</div> : null}
						<pre className="whitespace-pre-wrap break-words text-sm font-sans">{report.body || "No body recorded."}</pre>
						{report.providerSubmissionUrl ? <a href={report.providerSubmissionUrl} target="_blank" rel="noreferrer" className="inline-flex text-sm text-primary hover:underline">View provider submission status</a> : null}
						<AttachmentLinks ids={report.attachmentsArtifactIds} artifacts={artifactMap} />
					</CardContent>
				</Card>
			))}

			{abuseMailReports.map((report) => <StandaloneAbuseMailCard key={`abuse-mail-${String(report.id)}`} report={report} />)}
			{abuseProviderReports.map((report) => <StandaloneAbuseProviderCard key={`abuse-provider-${String(report.id)}`} report={report} />)}
		</div>
	);
}

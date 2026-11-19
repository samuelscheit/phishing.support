"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, FileText, Gavel, Inbox, Mail, Send, ShieldCheck, Trash2 } from "lucide-react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatUtcDateTime } from "@/lib/date_time";
import type { CampaignOverview, ReferralMailView } from "@/lib/referral/overview";
import { cn } from "@/web_lib/util";

const KIND_LABEL: Record<string, string> = {
	complaint: "Criminal complaint",
	supplement: "Supplement",
	preservation_notice: "Preservation notice",
};

const STATUS_LABEL: Record<string, string> = {
	awaiting_approval: "awaiting your approval",
	discarded: "discarded",
	verified: "approved, sending",
	running: "sending",
	awaiting_provider_reply: "sent, no reply yet",
	acknowledged: "answered",
	provider_rejected: "rejected",
	delivery_failed: "delivery failed",
	unknown_external_state: "delivery unknown",
};

const INDICATOR_LABEL: Record<string, string> = {
	operator_server: "Operator server",
	payment_receiver: "Payment receiver",
	kit_fingerprint: "Kit file",
	origin_ip: "Server",
};

function statusClass(status: string): string {
	if (status === "awaiting_approval") return "border-amber-300 bg-amber-50 text-amber-900";
	if (["acknowledged", "awaiting_provider_reply"].includes(status)) return "border-emerald-200 bg-emerald-50 text-emerald-800";
	if (["provider_rejected", "delivery_failed", "unknown_external_state"].includes(status)) return "border-red-200 bg-red-50 text-red-800";
	return "border-slate-200 bg-slate-50 text-slate-700";
}

async function post(url: string, body: unknown): Promise<string | undefined> {
	const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
	if (response?.ok) return undefined;
	const answer = await response?.json().catch(() => undefined) as { error?: string } | undefined;
	return answer?.error ?? "The request failed.";
}

function useAction() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const run = async (url: string, body: unknown) => {
		setBusy(true);
		setError(undefined);
		const failure = await post(url, body);
		setBusy(false);
		if (failure) setError(failure);
		else router.refresh();
		return !failure;
	};
	return { busy, error, run };
}

function ErrorLine({ error }: { error?: string }) {
	return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
}

function AuthorityCard({ authority, campaignId }: { authority: CampaignOverview["authorities"][number]; campaignId: string }) {
	const { busy, error, run } = useAction();
	const action = authority.hasComplaint ? "supplement" : "complaint";
	const disabled = busy || authority.hasDraftAwaitingApproval || (authority.hasComplaint && authority.unreportedSiteCount === 0);
	return (
		<div className="flex flex-col gap-3 rounded-lg border bg-background p-4">
			<div className="space-y-1">
				<p className="font-medium leading-snug">{authority.name}</p>
				<p className="font-mono text-xs text-muted-foreground">{authority.email}</p>
				<p className="text-sm text-muted-foreground">{authority.scope}</p>
			</div>
			{authority.caseReference && <p className="text-sm">File number: <span className="font-mono">{authority.caseReference}</span></p>}
			<div className="mt-auto flex flex-wrap items-center gap-2">
				<Button size="sm" variant={authority.hasComplaint ? "outline" : "default"} disabled={disabled} onClick={() => run(`/api/operator/campaigns/${campaignId}/referrals`, { action, authorityId: authority.id })}>
					<Gavel />
					{authority.hasDraftAwaitingApproval
						? "Draft waiting for approval"
						: authority.hasComplaint
							? authority.unreportedSiteCount > 0 ? `Draft supplement (${authority.unreportedSiteCount} new)` : "Has every site"
							: "Draft complaint"}
				</Button>
				<a href={authority.source} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline-offset-4 hover:underline">Source</a>
			</div>
			<ErrorLine error={error} />
		</div>
	);
}

function DraftEditor({ mail, reportId }: { mail: ReferralMailView; reportId?: string }) {
	const { busy, error, run } = useAction();
	const [subject, setSubject] = useState(mail.subject ?? "");
	const [body, setBody] = useState(mail.body ?? "");
	const changed = subject !== mail.subject || body !== mail.body;
	const url = `/api/operator/referral-mails/${mail.routeId}`;
	return (
		<div className="space-y-3">
			<label className="block space-y-1">
				<span className="text-xs font-medium text-muted-foreground">Subject</span>
				<Input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={400} />
			</label>
			<label className="block space-y-1">
				<span className="text-xs font-medium text-muted-foreground">Text</span>
				<Textarea value={body} onChange={(event) => setBody(event.target.value)} rows={22} className="font-mono text-xs leading-relaxed" />
			</label>
			<Attachments mail={mail} reportId={reportId} />
			<div className="flex flex-wrap items-center gap-2">
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button size="sm" disabled={busy}><Send />Approve and send</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Send this mail?</AlertDialogTitle>
							<AlertDialogDescription>
								It goes to {mail.recipientLabel} ({mail.recipient}) exactly as written, signed with your name. A sent mail cannot be recalled.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={() => run(url, { action: "approve", subject, body })}>Send</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
				<Button size="sm" variant="outline" disabled={busy || !changed} onClick={() => run(url, { action: "save", subject, body })}>
					<Check />Save draft
				</Button>
				<Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => run(url, { action: "discard" })}>
					<Trash2 />Discard
				</Button>
			</div>
			<ErrorLine error={error} />
		</div>
	);
}

function Attachments({ mail, reportId }: { mail: ReferralMailView; reportId?: string }) {
	if (!mail.attachments.length || !reportId) return null;
	return (
		<div className="flex flex-wrap items-center gap-3 text-xs">
			<span className="text-muted-foreground">Attachments:</span>
			{mail.attachments.map((attachment) => (
				<a key={attachment.id} href={`/api/operator/referral-attachments/${attachment.id}?report=${reportId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
					<FileText className="h-3.5 w-3.5" />{attachment.name}
				</a>
			))}
		</div>
	);
}

function CaseReferenceEditor({ mail }: { mail: ReferralMailView }) {
	const { busy, error, run } = useAction();
	const [value, setValue] = useState(mail.caseReference ?? "");
	const url = `/api/operator/referral-mails/${mail.routeId}`;
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<Input value={value} onChange={(event) => setValue(event.target.value)} placeholder="File number, e.g. 401 UJs 12345/26" className="h-8 max-w-xs font-mono text-xs" maxLength={60} />
				<Button size="sm" variant="outline" disabled={busy || value === (mail.caseReference ?? "")} onClick={() => run(url, { action: "case_reference", caseReference: value || null })}>
					Save file number
				</Button>
			</div>
			{mail.caseReferenceCandidates.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<span className="text-muted-foreground">The reply names:</span>
					{mail.caseReferenceCandidates.map((candidate) => (
						<button key={candidate} type="button" onClick={() => setValue(candidate)} className="rounded border px-2 py-0.5 font-mono hover:bg-muted">{candidate}</button>
					))}
				</div>
			)}
			<ErrorLine error={error} />
		</div>
	);
}

function MailCard({ mail, reportId }: { mail: ReferralMailView; reportId?: string }) {
	const awaiting = mail.status === "awaiting_approval";
	return (
		<Card className={cn(awaiting && "border-amber-300")}>
			<CardHeader className="gap-1 pb-3">
				<CardTitle className="flex flex-wrap items-center gap-2 text-base">
					{mail.kind === "preservation_notice" ? <ShieldCheck className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
					{KIND_LABEL[mail.kind] ?? mail.kind}
					<Badge variant="outline" className={statusClass(mail.status)}>{STATUS_LABEL[mail.status] ?? mail.status.replaceAll("_", " ")}</Badge>
					{mail.caseReference && <Badge variant="secondary" className="font-mono">{mail.caseReference}</Badge>}
				</CardTitle>
				<CardDescription className="break-words">
					To {mail.recipientLabel} &lt;{mail.recipient}&gt; · {mail.siteCount} {mail.siteCount === 1 ? "site" : "sites"} · drafted {formatUtcDateTime(mail.createdAt)}
					{mail.approvedAt ? ` · approved ${formatUtcDateTime(mail.approvedAt)}` : ""}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{awaiting ? <DraftEditor mail={mail} reportId={reportId} /> : (
					<>
						{mail.body && (
							<details className="rounded-md border bg-muted/30">
								<summary className="cursor-pointer px-3 py-2 text-sm">{mail.subject}</summary>
								<pre className="whitespace-pre-wrap break-words border-t px-3 py-2 font-mono text-xs leading-relaxed">{mail.body}</pre>
							</details>
						)}
						<Attachments mail={mail} reportId={reportId} />
						{mail.authorityId && mail.status !== "discarded" && <CaseReferenceEditor mail={mail} />}
					</>
				)}
				{mail.messages.filter((message) => message.direction === "inbound").map((message) => (
					<div key={message.id} className="space-y-1 rounded-md border bg-background p-3">
						<p className="flex flex-wrap items-center gap-2 text-sm font-medium">
							<Inbox className="h-4 w-4" />Reply from {message.from ?? "unknown sender"}
							<span className="text-xs font-normal text-muted-foreground">{formatUtcDateTime(message.occurredAt)}{message.classification ? ` · ${message.classification.replaceAll("_", " ")}` : ""}</span>
						</p>
						{message.subject && <p className="text-sm">{message.subject}</p>}
						{message.text && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{message.text}</pre>}
					</div>
				))}
			</CardContent>
		</Card>
	);
}

export function CampaignPageClient({ overview }: { overview: CampaignOverview }) {
	const { dossier } = overview;
	const preservation = useAction();
	const linking = overview.indicators.filter((indicator) => indicator.links);
	const servers = overview.indicators.filter((indicator) => indicator.kind === "origin_ip");
	return (
		<div className="space-y-8">
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">Campaign {overview.campaignId}</h1>
					<p className="text-sm text-muted-foreground">
						{dossier.sites.length} {dossier.sites.length === 1 ? "site" : "sites"} · {formatUtcDateTime(dossier.firstSeenAt)} – {formatUtcDateTime(dossier.lastSeenAt)}
						{dossier.impersonates.length ? ` · impersonates ${dossier.impersonates.join(", ")}` : ""}
					</p>
					{overview.mergedInto && <p className="text-sm text-amber-700">Merged into <a className="underline" href={`/operator/campaigns/${overview.mergedInto}`}>campaign {overview.mergedInto}</a>; its referrals stay here.</p>}
				</div>
				<Button asChild variant="outline" size="sm">
					<a href={`/api/operator/campaigns/${overview.campaignId}/dossier`}><Download />Dossier with evidence (ZIP)</a>
				</Button>
			</div>

			<section className="space-y-3">
				<h2 className="text-lg font-semibold">Criminal referral</h2>
				<div className="grid gap-3 md:grid-cols-3">
					{overview.authorities.map((authority) => <AuthorityCard key={authority.id} authority={authority} campaignId={overview.campaignId} />)}
				</div>
				{overview.canPreparePreservation && (
					<div className="flex flex-wrap items-center gap-3">
						<Button size="sm" variant="outline" disabled={preservation.busy} onClick={() => preservation.run(`/api/operator/campaigns/${overview.campaignId}/referrals`, { action: "preservation" })}>
							<ShieldCheck />Draft preservation notices to the providers
						</Button>
						<ErrorLine error={preservation.error} />
					</div>
				)}
				{overview.mails.length > 0 && (
					<div className="space-y-3">
						{overview.mails.map((mail) => <MailCard key={mail.routeId} mail={mail} reportId={overview.reportId} />)}
					</div>
				)}
			</section>

			<section className="space-y-3">
				<h2 className="text-lg font-semibold">What links the sites</h2>
				<Card>
					<CardContent className="divide-y p-0">
						{[...linking, ...servers].map((indicator) => (
							<div key={`${indicator.kind}:${indicator.value}`} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
								<span className="w-36 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">{INDICATOR_LABEL[indicator.kind] ?? indicator.kind}</span>
								<span className="min-w-0 break-words text-sm">{indicator.description}</span>
							</div>
						))}
						{linking.length === 0 && servers.length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">No indicators on record.</p>}
					</CardContent>
				</Card>
			</section>

			<section className="space-y-3">
				<h2 className="text-lg font-semibold">Sites</h2>
				<Card>
					<CardContent className="divide-y p-0">
						{dossier.sites.map((site) => (
							<div key={site.submissionId} className="space-y-1 px-4 py-3">
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<a href={`/submissions/${site.submissionId}`} className="min-w-0 break-all font-mono text-sm text-primary hover:underline">{site.url}</a>
									<span className="text-xs text-muted-foreground">{formatUtcDateTime(site.firstSeenAt)}</span>
								</div>
								<p className="text-xs text-muted-foreground">
									{site.reports.length
										? site.reports.map((report) => `${report.provider}: ${report.status.replaceAll("_", " ")}`).join(" · ")
										: "Not reported to a provider"}
								</p>
							</div>
						))}
					</CardContent>
				</Card>
			</section>
		</div>
	);
}

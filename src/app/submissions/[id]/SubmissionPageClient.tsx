"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { AnalysisLogs } from "@/components/AnalysisLogs";
import { AnalysisProgress } from "@/components/AnalysisProgress";
import { SubmissionStatus } from "@/components/SubmissionStatus";
import { ExternalLinkConfirm } from "@/components/ExternalLinkConfirm";
import { UrlParts } from "@/components/UrlParts";
import { WhoisTab } from "@/components/WhoisTab";
import { ReporterMeta } from "@/components/ReporterMeta";
import { ReportThreadTimeline } from "@/components/ReportThreadTimeline";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExternalLink, Mail, Globe, ShieldAlert } from "lucide-react";
import Link from "next/link";
import type { Artifact } from "@/lib/db/schema";
import type { SubmissionDetail as ApiSubmissionDetail } from "@/lib/submissions/details";
import { cn } from "../../../web_lib/util";

type SubmissionDetail = ApiSubmissionDetail;

function formatArtifactDate(value: Date | string | number | null | undefined) {
	if (value === null || value === undefined) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : format(date, "PPP p");
}

function isWebsiteArchiveArtifact(artifact: Pick<Artifact, "name" | "kind" | "mimeType">) {
	if (artifact.kind?.toLowerCase().startsWith("report_")) return false;
	const name = artifact.name?.toLowerCase();
	const kind = artifact.kind?.toLowerCase();
	const mimeType = artifact.mimeType?.toLowerCase();
	return (
		name?.startsWith("website.") ||
		kind?.startsWith("website_") ||
		mimeType === "text/mhtml"
	);
}

function isCorrespondenceArtifact(artifact: Pick<Artifact, "kind">) {
	return artifact.kind?.toLowerCase().startsWith("report_") ?? false;
}

export function SubmissionPageClient({ id, initialSubmission }: { id: string; initialSubmission?: SubmissionDetail | null }) {
	const [submission, setSubmission] = useState<SubmissionDetail | null>(initialSubmission ?? null);
	const [loading, setLoading] = useState(initialSubmission ? false : true);
	const [websiteHtml, setWebsiteHtml] = useState<string | null>(null);
	const [websiteHtmlError, setWebsiteHtmlError] = useState<string | null>(null);
	const [emailHtml, setEmailHtml] = useState<string | null>(null);
	const [emailHtmlError, setEmailHtmlError] = useState<string | null>(null);
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | null>(null);

	const statusKey = (submission?.status || "").toLowerCase();
	const isFailed = statusKey === "failed";
	const isReported = statusKey === "reported";

	const isRunning = ["new", "queued", "running"].includes(statusKey);
	const runsToShow = submission?.analysisRuns.slice(-1) || [];
	const reportThreads = submission?.reportThreads ?? [];
	const providerReports = submission?.providerReports ?? [];
	const reportCount = reportThreads.length + providerReports.length;

	const defaultTab = "runs";

	const retryAnalysis = async () => {
		setRetrying(true);
		setRetryError(null);
		try {
			const response = await fetch(`/api/submissions/${id}/retry`, { method: "POST" });
			const body = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(body.error || `Retry failed (${response.status})`);
			const refreshed = await fetch(`/api/submissions/${id}`);
			if (refreshed.ok) setSubmission(await refreshed.json());
		} catch (error) {
			setRetryError(error instanceof Error ? error.message : "Unable to queue retry.");
		} finally {
			setRetrying(false);
		}
	};

	const safeHostname = (rawUrl?: string) => {
		if (!rawUrl) return null;
		try {
			return new URL(rawUrl).hostname;
		} catch {
			return null;
		}
	};

	const targetName =
		submission?.data?.kind === "website"
			? safeHostname(submission.data.website?.url)
			: (submission?.data.email?.subject as string | undefined) || "Untitled Submission";

	const screenshot = submission?.artifacts?.find(
		(a) =>
			!isCorrespondenceArtifact(a) &&
			(((a.name?.toLowerCase() === "website.png" || a.name?.toLowerCase() === "mail.png") && a.mimeType?.startsWith("image/")) ||
				a.kind?.toLowerCase() === "website_png")
	);
	const websiteMhtml = submission?.artifacts?.find(
		(a) =>
			!isCorrespondenceArtifact(a) &&
			(a.name?.toLowerCase() === "website.mhtml" ||
				a.mimeType?.toLowerCase() === "text/mhtml" ||
				a.kind?.toLowerCase() === "website_mhtml")
	);
	const emailEml = submission?.artifacts?.find((a) => {
		if (isCorrespondenceArtifact(a)) return false;
		const name = a.name?.toLowerCase();
		const mime = a.mimeType?.toLowerCase();
		const kind = a.kind?.toLowerCase();
		return name?.endsWith(".eml") || name === "mail.eml" || mime === "message/rfc822" || kind === "eml";
	});
	const canRetryAnalysis =
		Boolean(
			isFailed &&
			submission &&
			(submission.kind === "website"
				? !submission.analysisRuns.length || submission.analysisRuns.at(-1)?.status === "failed"
				: submission.analysisRuns.every((run) => run.status === "failed")) &&
			reportCount === 0 &&
			(submission.data.kind === "website" ? Boolean(submission.data.website?.url) : Boolean(emailEml?.id)),
		);
	const artifacts = submission?.artifacts.filter((x) => x !== screenshot) || [];
	const websiteArchiveDate = formatArtifactDate(websiteMhtml?.archivedAt ?? websiteMhtml?.createdAt);

	const sanitizeHtmlForIframe = (rawHtml: string): string => {
		try {
			const parser = new DOMParser();
			const doc = parser.parseFromString(rawHtml, "text/html");

			// Wrap in a minimal doc to keep email styles from leaking.
			return `<!doctype html><html><head><meta charset="utf-8" /><meta name="referrer" content="no-referrer" /></head><body>${doc.body.innerHTML}</body></html>`;
		} catch {
			return rawHtml;
		}
	};

	useEffect(() => {
		const fetchDetail = async () => {
			try {
				const res = await fetch(`/api/submissions/${id}`);
				if (res.ok) {
					const data = await res.json();
					setSubmission(data);
				}
			} catch (err) {
				console.error("Failed to fetch submission:", err);
			} finally {
				setLoading(false);
			}
		};

		fetchDetail();
		const interval = setInterval(fetchDetail, 3000);
		return () => clearInterval(interval);
	}, [id]);

	useEffect(() => {
		let cancelled = false;
		const renderWebsite = async () => {
			setWebsiteHtml(null);
			setWebsiteHtmlError(null);
			if (submission?.kind !== "website") return;
			if (!websiteMhtml?.id) {
				setWebsiteHtmlError("No website snapshot (MHTML) artifact found.");
				return;
			}

			try {
				const res = await fetch(`/api/artifacts/${websiteMhtml.id}`);
				if (!res.ok) throw new Error(`Failed to fetch MHTML: ${res.status}`);
				const bytes = new Uint8Array(await res.arrayBuffer());
				const { convert } = await import("mhtml-to-html/browser");
				const { data } = await convert(bytes, { enableScripts: false, fetchMissingResources: false });
				if (cancelled) return;
				setWebsiteHtml(data);
			} catch (err) {
				console.error("Failed to render website snapshot:", err);
				if (cancelled) return;
				setWebsiteHtmlError("Failed to render website snapshot.");
			}
		};

		renderWebsite();
		return () => {
			cancelled = true;
		};
	}, [submission?.kind, websiteMhtml?.id]);

	useEffect(() => {
		let cancelled = false;
		const renderEmail = async () => {
			setEmailHtml(null);
			setEmailHtmlError(null);
			if (submission?.kind !== "email") return;
			if (!emailEml?.id) {
				setEmailHtmlError("No email (.eml) artifact found.");
				return;
			}

			try {
				const res = await fetch(`/api/artifacts/${emailEml.id}`);
				if (!res.ok) throw new Error(`Failed to fetch EML: ${res.status}`);
				const bytes = new Uint8Array(await res.arrayBuffer());

				const { default: PostalMime } = await import("postal-mime");
				const parser = new PostalMime();
				const parsed: any = await parser.parse(bytes);

				const raw =
					(parsed?.html as string | undefined) ||
					(typeof parsed?.text === "string" && parsed.text.trim().length > 0
						? `<!doctype html><html><head><meta charset="utf-8" /></head><body><pre style="white-space:pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${parsed.text
								.replace(/&/g, "&amp;")
								.replace(/</g, "&lt;")
								.replace(/>/g, "&gt;")}</pre></body></html>`
						: "");

				if (!raw) {
					throw new Error("No HTML/text content in EML");
				}

				const safe = sanitizeHtmlForIframe(raw);
				if (cancelled) return;
				setEmailHtml(safe);
			} catch (err) {
				console.error("Failed to render email:", err);
				if (cancelled) return;
				setEmailHtmlError("Failed to render email.");
			}
		};

		renderEmail();
		return () => {
			cancelled = true;
		};
	}, [submission?.kind, emailEml?.id]);

	if (loading && !submission) return <div className="p-10 text-center">Loading...</div>;
	if (!submission) return <div className="p-10 text-center">Submission not found</div>;

	return (
		<div className="container mx-auto py-10 px-4 space-y-6">
			<div className="flex items-center justify-between">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<Link href="/" className="text-sm text-muted-foreground hover:underline">
							Submissions
						</Link>
						<span className="text-muted-foreground">/</span>
						<span className="text-sm font-medium">{targetName}</span>
					</div>
				</div>
			</div>

			<div className="grid gap-6 items-stretch pt-4 md:grid-cols-12">
				<div className="col-span-8 h-full flex flex-col ">
					<div className="pb-4">
						<div className="flex justify-between items-start gap-0">
							<CardTitle className="flex flex-row items-center gap-2 min-w-0">
								{submission.kind === "website" ? (
									<Globe className="h-8 w-8 shrink-0" />
								) : (
									<Mail className="h-8 w-8 shrink-0" />
								)}
								<span className="leading-none text-xl -mt-1 wrap-break-word sm:text-2xl">{targetName}</span>
							</CardTitle>
							<div className="flex flex-col items-end gap-2 shrink-0 md:flex-row">
								<Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
									{new Date(submission.createdAt).toLocaleString(globalThis.navigator?.language || "en-US", {
										year: "numeric",
										month: "short",
										day: "numeric",
										hour: "2-digit",
										minute: "2-digit",
									})}
								</Badge>

								<SubmissionStatus status={submission.status} />
							</div>
						</div>
						<ReporterMeta
							reporterCountry={submission.reporterCountry}
							reporterHeaders={submission.reporterHeaders}
							className="mt-2"
						/>
					</div>
					<div className="space-y-5 flex-1 justify-between flex-col flex">
						{isReported && submission.data.kind === "website" ? (
							<div className="rounded-md border bg-destructive/10 p-3">
								<div className="flex items-center gap-2 text-xs font-semibold text-destructive">
									<ShieldAlert className="h-4 w-4" />
									Phishing Site
								</div>
								<div className="mt-1 text-sm font-bold text-destructive">
									Do not visit this site or enter any sensitive information.
								</div>
								<div className="text-xs text-slate-800">
									A phishing website is a fake site that looks like a real, trusted one (like your bank or a popular
									store). It tries to trick you into entering private information, such as your email, phone number,
									password or credit card.
								</div>
							</div>
						) : null}

						{isFailed ? (
							<div className="rounded-md border bg-muted/30 p-3">
								<div className="text-xs font-semibold text-muted-foreground">Failure reason</div>
								<div className="mt-1 text-sm whitespace-pre-wrap">{submission.info || "The analysis did not complete."}</div>
								{canRetryAnalysis ? (
									<div className="mt-3 flex flex-wrap items-center gap-3">
										<Button type="button" variant="outline" size="sm" disabled={retrying} onClick={retryAnalysis}>
											{retrying ? "Retrying analysis…" : "Retry analysis"}
										</Button>
										<span className="text-xs text-muted-foreground">
											{submission.kind === "website"
												? "Reuses the captured website archive when available; it will not create a duplicate report."
												: "Reuses the original email; it will not create a duplicate report."}
										</span>
									</div>
								) : null}
								{retryError ? <div className="mt-2 text-sm text-destructive">{retryError}</div> : null}
							</div>
						) : null}

						{submission.data.kind === "website" && (
							<div className="space-y-2">
								<div className="flex items-center justify-between gap-3">
									<h4 className="text-sm font-semibold">Website</h4>
								</div>
								<div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3">
									<div className="min-w-0 flex-1">
										{submission.data.website?.url ? (
											<UrlParts url={submission.data.website.url} />
										) : (
											<div className="font-mono text-xs">—</div>
										)}
									</div>
									{submission.data.website?.url ? (
										<ExternalLinkConfirm
											href={submission.data.website.url}
											trigger={
												<button
													type="button"
													className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-primary"
													aria-label="Open target URL"
												>
													<ExternalLink className="h-4 w-4" />
												</button>
											}
										/>
									) : null}
								</div>
							</div>
						)}

						{submission.data.kind === "email" && (
							<div className="space-y-2">
								<h4 className="text-sm font-semibold">Email</h4>
								<div className="grid gap-3 sm:grid-cols-2">
									<div className="rounded-lg border bg-muted/30 p-3">
										<div className="text-xs text-muted-foreground">From</div>
										<div className="mt-1 font-mono text-xs break-all">{submission.data.email?.from || "—"}</div>
									</div>
									<div className="rounded-lg border bg-muted/30 p-3">
										<div className="text-xs text-muted-foreground">Subject</div>
										<div className="mt-1 text-sm font-medium wrap-break-word">
											{submission.data.email?.subject || "—"}
										</div>
									</div>
								</div>
							</div>
						)}
					</div>
				</div>

				<div className="col-span-4 flex">
					{screenshot ? (
						<Card className="overflow-hidden h-full w-full border-none shadow-none">
							<div className="bg-muted overflow-hidden h-full flex relative">
								<img
									src={`/api/artifacts/${screenshot.id}`}
									alt="website.png"
									className="absolute object-contain w-full h-full"
								/>
							</div>
						</Card>
					) : isFailed && submission.info ? (
						<Card className="h-full w-full border-none shadow-none">
							<CardHeader>
								<CardTitle>Error</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="text-sm whitespace-pre-wrap">{submission.info}</div>
							</CardContent>
						</Card>
					) : null}
				</div>
			</div>

			<Tabs defaultValue={defaultTab} className="w-full">
				<TabsList className="overflow-x-auto max-w-full no-scrollbar">
					{submission.kind === "website" ? <TabsTrigger value="website">Website</TabsTrigger> : null}
					{submission.kind === "email" ? <TabsTrigger value="email">Email</TabsTrigger> : null}
					<TabsTrigger value="reports">Reports ({reportCount})</TabsTrigger>
					<TabsTrigger value="artifacts">Files ({artifacts.length})</TabsTrigger>
					<TabsTrigger value="runs">Analysis</TabsTrigger>
					{submission.kind === "website" ? <TabsTrigger value="whois">WhoIS</TabsTrigger> : null}
				</TabsList>
				{submission.kind === "website" && websiteMhtml ? (
					<TabsContent value="website" className="space-y-4 mt-4">
						<Card className="overflow-hidden">
							<CardHeader className="py-3">
								<CardTitle className="text-sm flex flex-row items-center gap-2">
									Archived Website
									<div className="text-xs text-muted-foreground font-normal">
										(from {websiteArchiveDate ?? "unknown date"})
									</div>
								</CardTitle>
								<CardDescription className="text-xs flex flex-row gap-8">
									<div className="text-zinc-500 font-semibold font-mono">DO NOT ENTER ANY SENSITIVE INFORMATION</div>
								</CardDescription>
							</CardHeader>
							<CardContent className="p-0">
								{websiteHtmlError ? (
									<div className="p-4 text-sm text-muted-foreground">{websiteHtmlError}</div>
								) : websiteHtml ? (
									<iframe
										title="Archived Website"
										srcDoc={websiteHtml}
										className="w-full h-[75vh] bg-background"
										sandbox=""
										referrerPolicy="no-referrer"
									/>
								) : (
									<div className="p-4 text-sm text-muted-foreground">Rendering…</div>
								)}
							</CardContent>
						</Card>
					</TabsContent>
				) : null}
				{submission.kind === "email" && emailEml ? (
					<TabsContent value="email" className="space-y-4 mt-4">
						<Card className="overflow-hidden">
							<CardHeader className="py-3">
								<CardTitle className="text-sm flex flex-row items-center gap-2">
									Archived Email
									<div className="text-xs text-muted-foreground font-normal">
										(from {format(new Date(emailEml.createdAt), "PPP p")})
									</div>
								</CardTitle>
								<CardDescription className="text-xs flex flex-row gap-8">
									<div className="text-zinc-500 font-semibold font-mono">
										DO NOT CLICK ANY LINKS NOR ENTER ANY SENSITIVE INFORMATION
									</div>
								</CardDescription>
							</CardHeader>
							<CardContent className="p-0">
								{emailHtmlError ? (
									<div className="p-4 text-sm text-muted-foreground">{emailHtmlError}</div>
								) : emailHtml ? (
									<iframe
										title="Archived Email"
										srcDoc={emailHtml}
										className="w-full h-[75vh] bg-background"
										sandbox=""
										referrerPolicy="no-referrer"
									/>
								) : (
									<div className="p-4 text-sm text-muted-foreground">Rendering…</div>
								)}
							</CardContent>
						</Card>
					</TabsContent>
				) : null}
				{submission.data.kind === "website" ? (
					<TabsContent value="whois" className="space-y-4 mt-4">
						<WhoisTab url={submission.data.website?.url} whois={submission.data.website?.whois} />
					</TabsContent>
				) : null}
				<TabsContent value="reports" className="space-y-4 mt-4">
					<ReportThreadTimeline threads={reportThreads} providerReports={providerReports} artifacts={submission.artifacts} />
				</TabsContent>
				<TabsContent value="runs" className="space-y-4 mt-4">
					<AnalysisProgress streamId={submission.id} status={submission.status} />

					{runsToShow.length > 0 ? (
						runsToShow.map((run: any) => (
							<div key={run.id} className={isRunning ? "overflow-hidden" : "overflow-hidden flex flex-col h-[90vh]"}>
								<div className="py-3 shrink-0">
									<div className="flex justify-between items-center">
										<CardTitle className="text-sm font-mono uppercase">AI Analysis</CardTitle>
										<Badge variant={run.status === "completed" ? "default" : "outline"}>{run.status}</Badge>
									</div>
								</div>
								<div className={cn(isRunning ? "p-0" : "p-0 flex-1 min-h-0", "pt-2")}>
									<AnalysisLogs streamId={run.id} output={run.output} className={isRunning ? undefined : "h-full"} />
								</div>
							</div>
						))
					) : (
						<div className="text-center py-10 text-muted-foreground">No analysis runs yet.</div>
					)}
				</TabsContent>
				<TabsContent value="artifacts" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
					{artifacts.length > 0 ? (
						artifacts.map((a) => (
							<Card key={a.id} className="overflow-hidden">
								{a.mimeType?.startsWith("image/") ? (
									<div className="aspect-video bg-muted relative">
										<img src={`/api/artifacts/${a.id}`} alt={a.name!} className="object-cover w-full h-full" />
									</div>
								) : (
									<div className="aspect-video flex items-center justify-center bg-muted">
										<ShieldAlert className="w-10 h-10 text-muted-foreground" />
									</div>
								)}
								<CardHeader className="p-3">
									<CardTitle className="text-xs truncate">{a.name || a.kind}</CardTitle>
									<CardDescription className="text-[10px]">
										{a.mimeType} • {((a.size || 0) / 1024).toFixed(1)} KB
										{isWebsiteArchiveArtifact(a) ? (
											<div>Archived {formatArtifactDate(a.archivedAt ?? a.createdAt) ?? "unknown date"}</div>
										) : null}
									</CardDescription>
								</CardHeader>
								<CardContent className="p-3 pt-0">
									<a
										href={`/api/artifacts/${a.id}`}
										download={a.name}
										className="text-[10px] text-primary hover:underline font-medium"
									>
										Download
									</a>
								</CardContent>
							</Card>
						))
					) : (
						<div className="text-center py-10 text-muted-foreground md:col-span-full">
							No artifacts found for this submission.
						</div>
					)}
				</TabsContent>
			</Tabs>
		</div>
	);
}

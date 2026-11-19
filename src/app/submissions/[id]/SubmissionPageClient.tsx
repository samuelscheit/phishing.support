"use client";

import { useEffect, useState } from "react";
import { AnalysisLogs } from "@/components/AnalysisLogs";
import { SubmissionStatus } from "@/components/SubmissionStatus";
import { ExternalLinkConfirm } from "@/components/ExternalLinkConfirm";
import { WhoisTab } from "@/components/WhoisTab";
import { ReporterMeta } from "@/components/ReporterMeta";
import { SubmissionReports } from "@/components/SubmissionReports";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowRight, ExternalLink, Mail, Globe, ShieldAlert } from "lucide-react";
import Link from "next/link";
import type { Artifact } from "@/lib/db/schema";
import type { SubmissionDetail as ApiSubmissionDetail } from "@/lib/submissions/details";
import { formatUtcDateTime } from "@/lib/date_time";
import { cn } from "../../../web_lib/util";
import { selectDisplayAnalysisRuns } from "@/lib/analysis_run_view";
import { CANARY_FIELD_LABEL, describeDataEntryField, isFlowStepHop, revisitWording, type WebsitePhishingBasis } from "@/lib/website_types";
import { SiteVisitBrowser, SiteVisitTimeline, useLiveVisit, type SiteVisitPage } from "@/components/SiteVisitPanel";
import { websiteSiteName } from "@/lib/website_site";
import { analyzedCaptureStep, latestArtifactNamed, websiteCaptureFileNames } from "@/lib/website_capture_files";

type SubmissionDetail = ApiSubmissionDetail;

const PHISHING_BASIS_LABELS: Record<WebsitePhishingBasis, string> = {
	credential_theft: "credential theft",
	payment_fraud: "payment fraud",
};

function formatArtifactSize(value: number | bigint | null | undefined) {
	if (value === null || value === undefined) return "Unknown size";
	const bytes = typeof value === "bigint" ? Number(value) : value;
	if (!Number.isSafeInteger(bytes) || bytes < 0) return "Unknown size";
	return (bytes / 1024).toFixed(1) + " KB";
}

function hostOfUrl(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function isWebsiteArchiveArtifact(artifact: Pick<Artifact, "kind">) {
	return artifact.kind.startsWith("website_");
}

/**
 * The way from a case to its campaign's page, which tells a visitor what to do
 * and lists the group's other sites; `#host` makes that page name this site.
 */
function CampaignLink({ campaign, host }: { campaign: NonNullable<SubmissionDetail["campaign"]>; host?: string }) {
	const several = campaign.siteCount > 1;
	return (
		<section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
			<p className="min-w-0 text-sm font-semibold">{several ? `One of ${campaign.siteCount} fake sites from the same group` : "A fake site"}</p>
			<Link href={`/campaigns/${campaign.id}${host ? `#${host}` : ""}`} className="inline-flex shrink-0 items-center gap-2 rounded-xl border bg-background px-4 py-2.5 text-sm font-medium shadow-sm transition-colors hover:bg-accent">
				{several ? `See all ${campaign.siteCount} sites and what to do` : "What to do"}<ArrowRight className="size-4" />
			</Link>
		</section>
	);
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
	const isInvalidWebsite = statusKey === "invalid" && submission?.kind === "website" && Boolean(submission.info);
	const redirectSubmissionId = submission?.data.kind === "website" ? submission.data.website.redirectSubmissionId : undefined;
	const websiteCloaking = submission?.data.kind === "website" ? submission.data.website.cloaking : undefined;
	const verificationGate = submission?.data.kind === "website" ? submission.data.website.verificationGate : undefined;
	const providerWarning = submission?.data.kind === "website" ? submission.data.website.providerWarning : undefined;
	const offeredDownload = submission?.data.kind === "website" ? submission.data.website.offeredDownload : undefined;
	const siteVisit = submission?.data.kind === "website" ? submission.data.website.visit : undefined;

	const isRunning = statusKey === "running";
	const websiteNavigation = submission?.data.kind === "website" ? submission.data.website.navigationHops ?? [] : [];
	const websiteAssessmentByHop = new Map(
		(submission?.data.kind === "website" ? submission.data.website.siteAssessments ?? [] : [])
			.map((assessment) => [assessment.hopIndex, assessment]),
	);
	const runsToShow = submission ? selectDisplayAnalysisRuns(submission.analysisRuns) : [];
	const reports = submission?.reports ?? [];
	const investigation = submission?.data.kind === "website" ? submission.data.website.investigation : undefined;
	// A report accepted before route resolution still counts, so the badge
	// never says zero while the tab shows its queued state.
	const reportCount = reports.reduce((count, report) => count + Math.max(1, report.routes.length), 0);

	const [tab, setTab] = useState("runs");
	const liveVisit = useLiveVisit(id, isRunning && submission?.kind === "website");
	// The page the finding rests on: the one whose content was captured and analyzed.
	const analyzedHop = websiteNavigation.find((hop) => hop.contentCaptured);
	const analyzedAssessment = analyzedHop ? websiteAssessmentByHop.get(analyzedHop.index) : undefined;
	const verdictLabel = analyzedAssessment?.finding === "phishing"
		? analyzedAssessment.phishingBasis ? `Phishing: ${PHISHING_BASIS_LABELS[analyzedAssessment.phishingBasis]}` : "Phishing"
		: analyzedAssessment?.finding === "malware"
			? analyzedAssessment.hiddenFrame ? "Malware: drive-by exploit in a hidden frame" : analyzedAssessment.offeredDownload ? "Malware: the file it offers" : "Malware distribution"
			: undefined;

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

	const targetName =
		submission?.data?.kind === "website"
			? websiteSiteName(submission.data.website?.url)
			: (submission?.data.email?.subject as string | undefined) || "Untitled Submission";

	// The analyzed page is the last one the visit reached; its archive is the MHTML of that step.
	const submissionArtifacts = submission?.artifacts ?? [];
	const analyzedFiles = websiteCaptureFileNames(analyzedCaptureStep(websiteNavigation));
	const emailScreenshot = submission?.kind === "email" ? latestArtifactNamed(submissionArtifacts, "mail.png") : undefined;
	const websiteMhtml = latestArtifactNamed(submissionArtifacts, analyzedFiles.mhtml);
	const emailEml = submission?.artifacts?.find((a) => {
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
				? submission.analysisRuns.every((run) => run.status !== "running")
				: submission.analysisRuns.every((run) => run.status === "failed")) &&
			reportCount === 0 &&
			(submission.data.kind === "website" ? Boolean(submission.data.website?.url) : Boolean(emailEml?.id)),
		);
	// Only the email image shown beside the facts is left out of the files; a website's screenshots are files.
	const artifacts = submission?.artifacts.filter((x) => x !== emailScreenshot) || [];
	const websiteArchiveDate = formatUtcDateTime(websiteMhtml?.archivedAt ?? websiteMhtml?.createdAt);
	// Each page of the visit with its screenshot: the pages it moved on from, the analyzed one, then those after it.
	const laterPages = submission?.data.kind === "website" ? submission.data.website?.laterPages ?? [] : [];
	const visitPages: SiteVisitPage[] = [
		...[...websiteNavigation.filter(isFlowStepHop), ...websiteNavigation.filter((hop) => hop.contentCaptured)].map((hop, step) => ({ url: hop.url, step })),
		...laterPages,
	].map(({ url, step }) => {
		const names = websiteCaptureFileNames(step);
		// The plain screenshot: the stamped copy's banner belongs to the evidence files, not the viewer.
		const shot = latestArtifactNamed(submissionArtifacts, names.screenshot) ?? latestArtifactNamed(submissionArtifacts, names.stampedScreenshot);
		return { url, ...(shot ? { screenshotId: String(shot.id) } : {}) };
	});

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
						? `<!doctype html><html><head><meta charset="utf-8" /></head><body><pre style="white-space:pre-wrap; overflow-wrap:anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${parsed.text
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

	const openSite = submission.data.kind === "website" && submission.data.website?.url ? (
		<ExternalLinkConfirm
			href={submission.data.website.url}
			trigger={
				<button type="button" className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-primary" aria-label="Open the submitted URL" title="Open the submitted URL">
					<ExternalLink className="h-4 w-4" />
				</button>
			}
		/>
	) : null;

	return (
		<div className="container mx-auto max-w-7xl py-8 px-4 space-y-6">
			<header className="space-y-3">
				<nav className="flex items-center gap-2 text-sm" aria-label="Breadcrumb">
					<Link href="/" className="text-muted-foreground hover:underline">Submissions</Link>
					<span className="text-muted-foreground">/</span>
					<span className="truncate font-medium">{targetName}</span>
				</nav>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0 space-y-1">
						<h1 className="flex items-center gap-2 text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
							{submission.kind === "website" ? <Globe className="h-6 w-6 shrink-0 text-muted-foreground" /> : <Mail className="h-6 w-6 shrink-0 text-muted-foreground" />}
							<span className="min-w-0">{targetName}</span>
						</h1>
						<ReporterMeta reporterCountry={submission.reporterCountry} reporterHeaders={submission.reporterHeaders} />
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
							{formatUtcDateTime(submission.createdAt) ?? "Unknown time"}
						</Badge>
						<SubmissionStatus status={submission.status} />
					</div>
				</div>
			</header>

			{submission.campaign ? <CampaignLink campaign={submission.campaign} host={submission.data.kind === "website" ? hostOfUrl(submission.data.website.url) : undefined} /> : null}

			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
				<div className="min-w-0 space-y-6">
					{submission.data.kind === "website" ? (
						<SiteVisitBrowser running={isRunning} pages={visitPages} live={liveVisit} fallbackUrl={submission.data.website?.url ?? ""} openAction={openSite} />
					) : null}
					{submission.data.kind === "email" && (
						<div className="space-y-2">
							<h4 className="text-sm font-semibold">Email</h4>
							<div className="grid gap-3 sm:grid-cols-2">
								<div className="rounded-lg border bg-muted/30 p-3">
									<div className="text-xs text-muted-foreground">From</div>
									<div className="mt-1 font-mono text-xs">{submission.data.email?.from || "—"}</div>
								</div>
								<div className="rounded-lg border bg-muted/30 p-3">
									<div className="text-xs text-muted-foreground">Subject</div>
									<div className="mt-1 text-sm font-medium">
										{submission.data.email?.subject || "—"}
									</div>
								</div>
							</div>
							{submission.data.email?.linkedWebsites?.length ? (
								<div className="rounded-lg border bg-muted/30 p-3">
									<div className="text-xs text-muted-foreground">Linked websites, each analyzed in its own case</div>
									<ul className="mt-1 space-y-1">
										{submission.data.email.linkedWebsites.map((link) => (
											<li key={link.url} className="flex items-start justify-between gap-3">
												<span className="min-w-0 font-mono text-xs">{link.url}</span>
												<Link href={`/submissions/${link.submissionId}`} className="shrink-0 text-xs font-medium text-primary hover:underline">
													Open case
												</Link>
											</li>
										))}
									</ul>
								</div>
							) : null}
						</div>
					)}
					<Tabs value={tab} onValueChange={setTab} className="w-full min-w-0">
						<TabsList className="overflow-x-auto max-w-full no-scrollbar">
												{submission.kind === "email" ? <TabsTrigger value="email">Email</TabsTrigger> : null}
							<TabsTrigger value="runs">Analysis</TabsTrigger>
							{submission.kind === "website" && websiteNavigation.length > 0 ? <TabsTrigger value="navigation">Navigation</TabsTrigger> : null}
							<TabsTrigger value="reports">Reports ({reportCount})</TabsTrigger>
							<TabsTrigger value="artifacts">Files ({artifacts.length})</TabsTrigger>
							{submission.kind === "website" && websiteMhtml ? <TabsTrigger value="website">Archived page</TabsTrigger> : null}
							{submission.kind === "website" ? <TabsTrigger value="whois">WHOIS</TabsTrigger> : null}
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
										<div className="text-xs text-muted-foreground">
											Captured page: {submission.data.kind === "website" ? submission.data.website.archiveUrl ?? submission.data.website.url : "unknown"}
										</div>
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
												className="w-full h-[70vh] bg-background"
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
												(from {formatUtcDateTime(emailEml.createdAt) ?? "unknown date"})
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
												className="w-full h-[70vh] bg-background"
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
							{investigation ? (
								<Card>
									<CardContent className="space-y-2 p-4">
										<div className="flex flex-wrap items-center justify-between gap-3">
											<div>
												<div className="text-sm font-medium">Pre-report investigation</div>
												<div className="text-xs text-muted-foreground">
													{investigation.status === "completed"
														? `Evidence collected before any provider was contacted: ${investigation.payloads?.length ?? 0} command payload${investigation.payloads?.length === 1 ? "" : "s"}, ${investigation.backendCount ?? 0} data-drop backend${investigation.backendCount === 1 ? "" : "s"}.`
														: investigation.status === "failed"
															? "The investigation could not be completed; the report was sent with the evidence already captured."
															: "Payloads are downloaded and checked, and a controlled browser submits synthetic values, before the report is sent."}
												</div>
											</div>
											<Badge variant="outline" className="capitalize">{investigation.status}</Badge>
										</div>
										{investigation.payloads?.map((payload) => (
											<div key={payload.url} className="rounded border bg-muted/20 p-2 text-xs">
												<div className="font-mono">{payload.url}</div>
												{payload.sha256 ? <div className="text-muted-foreground">SHA-256 {payload.sha256}{payload.sizeBytes ? ` · ${formatArtifactSize(payload.sizeBytes)}` : ""}</div> : null}
												{payload.verdict ? <div className="font-medium text-destructive">{payload.verdict}</div> : null}
												{payload.error ? <div className="text-muted-foreground">Not downloaded: {payload.error}</div> : null}
											</div>
										))}
										{investigation.probeError ? <div className="text-xs text-muted-foreground">Form probe: {investigation.probeError}</div> : null}
									</CardContent>
								</Card>
							) : null}
							<SubmissionReports submissionId={id} reports={reports} />
						</TabsContent>
						{submission.kind === "website" && websiteNavigation.length > 0 ? (
							<TabsContent value="navigation" className="space-y-2 mt-4">
								<p className="text-xs text-muted-foreground">Redirects and followed links within one site belong to that site and share the finding of the page they lead to. A destination on another host is never attributed to the URL that redirected to it.</p>
								<ol className="space-y-2">
									{websiteNavigation.map((hop) => {
										const assessment = websiteAssessmentByHop.get(hop.index);
										const finding = assessment?.finding;
										const findingLabel = finding === "prank_or_troll"
											? "Prank / troll — not phishing"
											: finding === "insufficient_evidence" ? "Insufficient evidence"
												: finding === "phishing" ? (assessment?.phishingBasis ? `Phishing — ${PHISHING_BASIS_LABELS[assessment.phishingBasis]}` : "Phishing")
													: finding === "malware" ? (assessment?.hiddenFrame ? "Malware — drive-by exploit in a hidden frame" : assessment?.offeredDownload ? "Malware — the file it offers" : "Malware distribution")
														: finding === "benign" ? "Not phishing or malware" : undefined;
										return (
											<li key={`${hop.index}:${hop.url}`} className="rounded border bg-background p-2">
												<div className="flex items-start justify-between gap-2">
													<div className="min-w-0 space-y-1">
														<div className="font-mono text-xs">{hop.url}</div>
														<div className="text-xs text-muted-foreground">
															HTTP {hop.status ?? "unknown"}{hop.contentCaptured ? " · Page captured and analyzed" : hop.visitorStep ? " · Page captured, the visit moved on" : hop.revisit ? ` · Page captured, ${revisitWording(hop.revisit).cause}` : hop.status !== null && hop.status >= 300 && hop.status < 400 ? " · redirect response only" : " · left by script"}
														</div>
														{hop.visitorStep && hop.redirectTo ? (
															<div className="text-xs text-muted-foreground">
																{hop.visitorStep.submitted.length
																	? <>The visit entered the made-up {hop.visitorStep.submitted.map((field) => CANARY_FIELD_LABEL[field]).join(", ")} here; it then showed {hop.redirectTo}</>
																	: <>The visit moved on to {hop.redirectTo}</>}
															</div>
														) : hop.revisit && hop.redirectTo ? (
															<div className="text-xs text-muted-foreground">Opened again {revisitWording(hop.revisit).opened}, it shows {hop.redirectTo}</div>
														) : hop.redirectTo ? <div className="text-xs text-muted-foreground">Redirects to {hop.redirectTo}</div> : null}
														{verificationGate && hop.contentCaptured ? (
															<div className="text-xs text-muted-foreground">Behind the page's own “{verificationGate.label}” gate, clicked to reveal it</div>
														) : null}
														{providerWarning && hop.contentCaptured ? (
															<div className="text-xs text-muted-foreground">{providerWarning.provider} shows its “{providerWarning.warning}” warning before this page; the visit proceeded past it</div>
														) : null}
														{offeredDownload && hop.contentCaptured ? (
															<div className="space-y-0.5 text-xs text-muted-foreground">
																<div>Offers <span className="font-mono">{offeredDownload.fileName}</span> ({offeredDownload.sizeBytes.toLocaleString()} bytes), downloaded by the visit and inspected without running it</div>
																<div className="font-mono">SHA-256 {offeredDownload.sha256}</div>
																{offeredDownload.inspection.browserExtension ? (
																	<div>Browser extension “{offeredDownload.inspection.browserExtension.name}” with permissions {[...offeredDownload.inspection.browserExtension.permissions, ...offeredDownload.inspection.browserExtension.hostPermissions].join(", ")}</div>
																) : null}
															</div>
														) : null}
														{redirectSubmissionId && hop.contentCaptured ? (
															<Link href={`/submissions/${redirectSubmissionId}`} className="inline-block text-xs font-medium text-primary hover:underline">
																Analyzed in its own case →
															</Link>
														) : null}
														{findingLabel ? <div className={cn("text-xs font-medium", finding === "phishing" || finding === "malware" ? "text-destructive" : "text-muted-foreground")}>{findingLabel}</div> : null}
														{assessment?.evidenceQuote ? <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground">“{assessment.evidenceQuote}”</blockquote> : null}
														{assessment?.collectionFields?.length ? (
															<div className="text-xs text-muted-foreground">
																Collects data through: {assessment.collectionFields.map((field) => `“${describeDataEntryField(field)}”`).join(", ")}
															</div>
														) : null}
														{assessment?.rejectedClaim ? (
															<div className="text-xs text-muted-foreground">Classifier&apos;s finding not corroborated: {assessment.rejectedClaim}</div>
														) : null}
													</div>
													<ExternalLinkConfirm
														href={hop.url}
														description="This opens this exact URL; your browser may follow its redirects."
														trigger={<button type="button" className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-primary" aria-label={`Open redirect hop ${hop.index + 1}`}><ExternalLink className="h-4 w-4" /></button>}
													/>
												</div>
											</li>
										);
									})}
								</ol>
							</TabsContent>
						) : null}
						<TabsContent value="runs" className="space-y-4 mt-4">
							{runsToShow.length > 0 ? (
								runsToShow.map((run: any) => (
									<div key={run.id} className={isRunning ? "overflow-hidden" : "overflow-hidden flex flex-col h-[90vh]"}>
										<div className={cn(isRunning ? "p-0" : "p-0 flex-1 min-h-0", "pt-2")}>
											<AnalysisLogs
												streamId={run.id}
												progressStreamId={isRunning ? submission.id : undefined}
												status={run.status}
												output={run.output}
												className={isRunning ? undefined : "h-full"}
											/>
										</div>
									</div>
								))
							) : isRunning ? (
								<AnalysisLogs streamId={submission.id} status={submission.status} progressOnly />
							) : (
								<div className="text-center py-10 text-muted-foreground">No analysis runs yet.</div>
							)}
						</TabsContent>
						<TabsContent value="artifacts" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
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
												{a.mimeType} • {formatArtifactSize(a.size)}
												{a.sha256 ? <div className="font-mono">SHA-256 {a.sha256}</div> : null}
												{isWebsiteArchiveArtifact(a) ? (
													<div>Archived {formatUtcDateTime(a.archivedAt ?? a.createdAt) ?? "unknown date"}</div>
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

				<aside className="min-w-0 space-y-4 lg:sticky lg:top-6">
					{isReported ? (
						<section className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
							<div className="flex items-center gap-2 text-sm font-semibold text-destructive">
								<ShieldAlert className="h-4 w-4" />
								{verdictLabel ?? "Phishing confirmed"}
							</div>
							{analyzedAssessment?.impersonatedBrand ? (
								<p className="mt-2 text-sm">
									Impersonates <span className="font-medium">{analyzedAssessment.impersonatedBrand.name}</span>
									<span className="text-muted-foreground"> · official site </span>
									<span className="text-muted-foreground">{hostOfUrl(analyzedAssessment.impersonatedBrand.officialUrl)}</span>
								</p>
							) : null}
							{analyzedAssessment?.evidenceQuote ? (
								<>
									<div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Evidence</div>
									<blockquote className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground">“{analyzedAssessment.evidenceQuote}”</blockquote>
								</>
							) : null}
							{analyzedAssessment?.collectionFields?.length ? (
								<p className="mt-2 text-xs text-muted-foreground">Asks for {analyzedAssessment.collectionFields.map((field) => `“${describeDataEntryField(field)}”`).join(", ")}</p>
							) : null}
							{/* A confirmed site with no report: its case was confirmed from evidence collected elsewhere, after the site was gone; its info says why. */}
							{reportCount ? (
								<div className="mt-3 flex items-center justify-between gap-2 border-t border-destructive/15 pt-3 text-xs">
									<span className="text-muted-foreground">Being reported to the responsible providers.</span>
									<button type="button" onClick={() => setTab("reports")} className="shrink-0 font-medium text-primary hover:underline">{reportCount} report{reportCount === 1 ? "" : "s"} →</button>
								</div>
							) : (
								<p className="mt-3 border-t border-destructive/15 pt-3 text-xs text-muted-foreground whitespace-pre-wrap">{submission.info || "No report was sent."}</p>
							)}
						</section>
					) : null}

					{isInvalidWebsite ? (
							<div className="rounded-lg border bg-muted/30 p-4">
								<div className="text-xs font-semibold text-muted-foreground">Not reported</div>
								<div className="mt-1 text-sm whitespace-pre-wrap">{submission.info}</div>
							</div>
						) : null}

					{statusKey === "redirected" ? (
							<div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
								<div className="text-xs font-semibold text-amber-700 dark:text-amber-400">{websiteCloaking?.outcome === "detected" ? "Cloaks: shows scanners a different site" : "Redirects to another site"}</div>
								<div className="mt-1 text-sm whitespace-pre-wrap">{submission.info}</div>
								{redirectSubmissionId ? (
									<Link href={`/submissions/${redirectSubmissionId}`} className="mt-2 inline-block text-sm font-medium text-primary hover:underline">
										Open the case for the destination
									</Link>
								) : null}
							</div>
						) : null}

					{isFailed ? (
							<div className="rounded-lg border bg-muted/30 p-4">
								<div className="text-xs font-semibold text-muted-foreground">Failure reason</div>
								<div className="mt-1 text-sm whitespace-pre-wrap">{submission.info || "The analysis did not complete."}</div>
								{canRetryAnalysis ? (
									<div className="mt-3 flex flex-wrap items-center gap-3">
										<Button type="button" variant="outline" size="sm" disabled={retrying} onClick={retryAnalysis}>
											{retrying ? "Retrying analysis…" : "Retry analysis"}
										</Button>
										<span className="text-xs text-muted-foreground">
											{submission.kind === "website"
												? websiteCloaking?.outcome === "unresolved"
													? "Visits the site again, including from the residential exit; it will not create a duplicate report."
													: "Reuses the captured website archive when available; it will not create a duplicate report."
												: "Reuses the original email; it will not create a duplicate report."}
										</span>
									</div>
								) : null}
								{retryError ? <div className="mt-2 text-sm text-destructive">{retryError}</div> : null}
							</div>
						) : null}

					{submission.data.kind === "website" ? (
						<SiteVisitTimeline running={isRunning} visit={siteVisit} offeredDownload={offeredDownload} live={liveVisit} pageCount={visitPages.length} />
					) : null}

					{emailScreenshot ? (
						<div className="overflow-hidden rounded-lg border bg-muted">
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img src={`/api/artifacts/${emailScreenshot.id}`} alt="The reported email, rendered" className="block h-auto w-full" />
						</div>
					) : null}
				</aside>
			</div>
		</div>
	);
}

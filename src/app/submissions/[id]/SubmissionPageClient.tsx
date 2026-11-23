"use client";

import { useState } from "react";
import { SubmissionStatus } from "@/components/SubmissionStatus";
import { ExternalLinkConfirm } from "@/components/ExternalLinkConfirm";
import { WhoisTab } from "@/components/WhoisTab";
import { ReporterMeta } from "@/components/ReporterMeta";
import { SubmissionReports } from "@/components/SubmissionReports";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExternalLink, Mail, Globe } from "lucide-react";
import type { Locale } from "@/lib/i18n/locale";
import Link from "next/link";
import type { SubmissionDetail } from "@/lib/submissions/details";
import { formatUtcDateTime } from "@/lib/util/date_time";
import { selectDisplayAnalysisRuns } from "@/lib/analysis/run_view";
import { isFlowStepHop } from "@/lib/website/types";
import { SiteVisitBrowser, SiteVisitTimeline, useLiveVisit, type SiteVisitPage } from "@/components/SiteVisitPanel";
import { websiteSiteName } from "@/lib/website/info/site";
import { analyzedPage, latestArtifactNamed, websiteCaptureFileNames } from "@/lib/website/visit/capture_files";
import { ArchivedFrame } from "./_components/ArchivedFrame";
import { ArtifactsTab } from "./_components/ArtifactsTab";
import { CampaignLink } from "./_components/CampaignLink";
import { EmailFacts } from "./_components/EmailFacts";
import { InvestigationCard } from "./_components/InvestigationCard";
import { NavigationTab } from "./_components/NavigationTab";
import { RunsTab } from "./_components/RunsTab";
import { FailedPanel, NotReportedPanel, VerdictPanel } from "./_components/StatusPanels";
import { reportedSites } from "./_components/helpers";
import { useArchivedHtml } from "./_components/useArchivedHtml";
import { useSubmissionDetail } from "./_components/useSubmissionDetail";
import { hostOf } from "@/lib/network/url";

function isEmlArtifact(a: SubmissionDetail["artifacts"][number]) {
	const name = a.name?.toLowerCase();
	const mime = a.mimeType?.toLowerCase();
	const kind = a.kind?.toLowerCase();
	return name?.endsWith(".eml") || name === "mail.eml" || mime === "message/rfc822" || kind === "eml";
}

export function SubmissionPageClient({ id, initialSubmission, locale }: { id: string; initialSubmission?: SubmissionDetail | null; locale: Locale }) {
	const { submission, loading, retrying, retryError, retryAnalysis } = useSubmissionDetail(id, initialSubmission);
	const [tab, setTab] = useState("runs");

	const statusKey = (submission?.status || "").toLowerCase();
	const isFailed = statusKey === "failed";
	const isReported = statusKey === "reported";
	const isRunning = statusKey === "running";
	const isInvalidWebsite = statusKey === "invalid" && submission?.kind === "website" && Boolean(submission.info);
	const website = submission?.data.kind === "website" ? submission.data.website : undefined;
	const websiteCloaking = website?.cloaking;
	const offeredDownload = website?.offeredDownload;
	const websiteNavigation = website?.navigationHops ?? [];
	const websiteAssessmentByHop = new Map((website?.siteAssessments ?? []).map((assessment) => [assessment.hopIndex, assessment]));
	const runsToShow = submission ? selectDisplayAnalysisRuns(submission.analysisRuns) : [];
	const reports = submission?.reports ?? [];
	// A report accepted before route resolution still counts, so the badge
	// never says zero while the tab shows its queued state.
	const reportCount = reports.reduce((count, report) => count + Math.max(1, report.routes.length), 0);

	const liveVisit = useLiveVisit(id, isRunning && submission?.kind === "website");
	// Each reported site of the chain, with the verdict every hop of it shares.
	const confirmedSites = reportedSites(websiteNavigation, websiteAssessmentByHop);

	const targetName =
		submission?.data.kind === "website"
			? websiteSiteName(submission.data.website?.url)
			: (submission?.data.email?.subject as string | undefined) || "Untitled Submission";

	// The page the case's verdict rests on; its archive is the MHTML of its step.
	const submissionArtifacts = submission?.artifacts ?? [];
	const analyzed = website ? analyzedPage(website) : undefined;
	const analyzedFiles = websiteCaptureFileNames(analyzed?.step ?? 0);
	const emailScreenshot = submission?.kind === "email" ? latestArtifactNamed(submissionArtifacts, "mail.png") : undefined;
	const websiteMhtml = latestArtifactNamed(submissionArtifacts, analyzedFiles.mhtml);
	const emailEml = submissionArtifacts.find(isEmlArtifact);
	const websiteArchive = useArchivedHtml("website", submission?.kind === "website", websiteMhtml?.id);
	const emailArchive = useArchivedHtml("email", submission?.kind === "email", emailEml?.id);
	const canRetryAnalysis =
		Boolean(
			isFailed &&
			submission &&
			(submission.kind === "website"
				? submission.analysisRuns.every((run) => run.status !== "running")
				: submission.analysisRuns.every((run) => run.status === "failed")) &&
			reportCount === 0 &&
			(website ? Boolean(website.url) : Boolean(emailEml?.id)),
		);
	// Only the email image shown beside the facts is left out of the files; a website's screenshots are files.
	const artifacts = submissionArtifacts.filter((x) => x !== emailScreenshot);
	// Each page of the chain with its screenshot, in the order shown: the pages the visit moved on from, then the last one.
	const visitPages: SiteVisitPage[] = [...websiteNavigation.filter(isFlowStepHop), ...websiteNavigation.filter((hop) => hop.contentCaptured)].map((hop, step) => ({ url: hop.url, step })).map(({ url, step }) => {
		const names = websiteCaptureFileNames(step);
		// The plain screenshot: the stamped copy's banner belongs to the evidence files, not the viewer.
		const shot = latestArtifactNamed(submissionArtifacts, names.screenshot) ?? latestArtifactNamed(submissionArtifacts, names.stampedScreenshot);
		return { url, ...(shot ? { screenshotId: String(shot.id) } : {}) };
	});

	if (loading && !submission) return <div className="p-10 text-center">Loading...</div>;
	if (!submission) return <div className="p-10 text-center">Submission not found</div>;

	const openSite = website?.url ? (
		<ExternalLinkConfirm
			href={website.url}
			trigger={
				<button type="button" className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-primary" aria-label="Open the submitted URL" title="Open the submitted URL">
					<ExternalLink className="h-4 w-4" />
				</button>
			}
		/>
	) : null;

	const retryHint = submission.kind === "website"
		? websiteCloaking?.outcome === "unresolved"
			? "Visits the site again, including from the residential exit; it will not create a duplicate report."
			: "Reuses the captured website archive when available; it will not create a duplicate report."
		: "Reuses the original email; it will not create a duplicate report.";

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

			{submission.campaign ? <CampaignLink campaign={submission.campaign} host={website ? hostOf(website.url) : undefined} locale={locale} /> : null}

			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
				<div className="min-w-0 space-y-6">
					{website ? (
						<SiteVisitBrowser running={isRunning} pages={visitPages} initialPage={analyzed?.step} live={liveVisit} fallbackUrl={website.url ?? ""} openAction={openSite} />
					) : null}
					{submission.data.kind === "email" && <EmailFacts email={submission.data.email} />}
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
						{website && websiteMhtml ? (
							<TabsContent value="website" className="space-y-4 mt-4">
								<ArchivedFrame
									title="Archived Website"
									date={formatUtcDateTime(websiteMhtml.archivedAt ?? websiteMhtml.createdAt) ?? "unknown date"}
									subtitle={`Captured page: ${analyzed?.hop.url ?? website.url}`}
									warning="DO NOT ENTER ANY SENSITIVE INFORMATION"
									{...websiteArchive}
								/>
							</TabsContent>
						) : null}
						{submission.kind === "email" && emailEml ? (
							<TabsContent value="email" className="space-y-4 mt-4">
								<ArchivedFrame
									title="Archived Email"
									date={formatUtcDateTime(emailEml.createdAt) ?? "unknown date"}
									warning="DO NOT CLICK ANY LINKS NOR ENTER ANY SENSITIVE INFORMATION"
									{...emailArchive}
								/>
							</TabsContent>
						) : null}
						{website ? (
							<TabsContent value="whois" className="space-y-4 mt-4">
								<WhoisTab url={website.url} whois={website.whois} />
							</TabsContent>
						) : null}
						<TabsContent value="reports" className="space-y-4 mt-4">
							{website?.investigation ? <InvestigationCard investigation={website.investigation} /> : null}
							<SubmissionReports reports={reports} caseId={id} />
						</TabsContent>
						{website && websiteNavigation.length > 0 ? (
							<TabsContent value="navigation" className="space-y-2 mt-4">
								<NavigationTab hops={websiteNavigation} assessments={websiteAssessmentByHop} website={website} artifacts={submissionArtifacts} />
							</TabsContent>
						) : null}
						<TabsContent value="runs" className="space-y-4 mt-4">
							<RunsTab submission={submission} runs={runsToShow} isRunning={isRunning} />
						</TabsContent>
						<TabsContent value="artifacts" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
							<ArtifactsTab artifacts={artifacts} />
						</TabsContent>
					</Tabs>
				</div>

				<aside className="min-w-0 space-y-4 lg:sticky lg:top-6">
					{isReported ? (
						<VerdictPanel sites={confirmedSites} submittedSite={targetName ?? null} reportCount={reportCount} joinedCases={reports.every((report) => report.submissionId !== null && String(report.submissionId) !== id) ? [...new Set(reports.map((report) => String(report.submissionId)))] : []} info={submission.info} onShowReports={() => setTab("reports")} />
					) : null}
					{isInvalidWebsite ? <NotReportedPanel info={submission.info} /> : null}
					{isFailed ? <FailedPanel info={submission.info} canRetry={canRetryAnalysis} retrying={retrying} retryError={retryError} retryHint={retryHint} onRetry={retryAnalysis} /> : null}
					{website ? (
						<SiteVisitTimeline running={isRunning} visit={website.visit} offeredDownload={offeredDownload} live={liveVisit} pageCount={visitPages.length} />
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

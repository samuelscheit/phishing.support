"use client";

import { useState } from "react";
import { SubmissionStatus } from "@/components/SubmissionStatus";
import { ExternalLinkConfirm } from "@/components/ExternalLinkConfirm";
import { WhoisTab } from "@/components/WhoisTab";
import { ReporterMeta } from "@/components/ReporterMeta";
import { SubmissionReports } from "@/components/reports/ReportsTab";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExternalLink, Mail, Globe, RotateCcw } from "lucide-react";
import type { Locale } from "@/lib/i18n/locale";
import Link from "next/link";
import type { SubmissionDetail } from "@/lib/submissions/details";
import { formatUtcDateTime } from "@/lib/util/date_time";
import { selectDisplayAnalysisRuns } from "@/lib/analysis/run_view";
import { isFlowStepHop, type WebsiteRoute } from "@/lib/website/types";
import { SiteVisitBrowser, SiteVisitTimeline, useLiveVisit, type SiteVisitPage } from "@/components/SiteVisitPanel";
import { websiteSiteName } from "@/lib/website/info/site";
import { analyzedPage, latestArtifactNamed, websiteCaptureFileNames, type CapturePage } from "@/lib/website/visit/capture_files";
import { ArchivedFrame } from "./_components/ArchivedFrame";
import { ArtifactsTab } from "./_components/ArtifactsTab";
import { CampaignLink } from "./_components/CampaignLink";
import { EmailFacts } from "./_components/EmailFacts";
import { NavigationTab } from "./_components/NavigationTab";
import { RunsTab } from "./_components/RunsTab";
import { RotationNote } from "./_components/RotationNote";
import { RouteSelector } from "./_components/RouteSelector";
import { OutcomePanel, VerdictPanel } from "./_components/StatusPanels";
import { caseReportedAs } from "@/lib/submissions/finding";
import { canAnalyzeAgain, deceptiveFunnels, reportedSites, retryCountLabel, routeLabel } from "./_components/helpers";
import { useArchivedHtml } from "./_components/useArchivedHtml";
import { useSubmissionDetail } from "./_components/useSubmissionDetail";

function isEmlArtifact(a: SubmissionDetail["artifacts"][number]) {
	const name = a.name?.toLowerCase();
	const mime = a.mimeType?.toLowerCase();
	const kind = a.kind?.toLowerCase();
	return name?.endsWith(".eml") || name === "mail.eml" || mime === "message/rfc822" || kind === "eml";
}

/** Each page of route `route` with its screenshot and preview, in the order shown: the pages the visit moved on from, then the last one. */
function routePages(route: number, walked: WebsiteRoute | undefined, artifacts: SubmissionDetail["artifacts"]): SiteVisitPage[] {
	const hops = walked?.hops ?? [];
	return [...hops.filter(isFlowStepHop), ...hops.filter((hop) => hop.contentCaptured)].map((hop, step) => {
		const names = websiteCaptureFileNames({ route, step });
		// The plain screenshot: the stamped copy's banner belongs to the evidence files, not the viewer.
		const shot = latestArtifactNamed(artifacts, names.screenshot) ?? latestArtifactNamed(artifacts, names.stampedScreenshot);
		const preview = latestArtifactNamed(artifacts, names.preview);
		return { url: hop.url, ...(shot ? { screenshotId: String(shot.id) } : {}), ...(preview ? { previewId: String(preview.id) } : {}) };
	});
}

export function SubmissionPageClient({ id, initialSubmission, locale }: { id: string; initialSubmission?: SubmissionDetail | null; locale: Locale }) {
	const { submission, loading, retrying, retryError, retryAnalysis } = useSubmissionDetail(id, initialSubmission);
	const [tab, setTab] = useState("runs");
	// The route picked in the route selector; until one is, the route of the case's headline page.
	const [chosenRoute, setChosenRoute] = useState<number | null>(null);

	const statusKey = (submission?.status || "").toLowerCase();
	const isFailed = statusKey === "failed";
	const isReported = statusKey === "reported";
	const isRunning = statusKey === "running";
	const isInvalid = statusKey === "invalid";
	const website = submission?.data.kind === "website" ? submission.data.website : undefined;
	const websiteCloaking = website?.cloaking;
	const routes = website?.routes ?? [];
	const analyzedRoute = website?.analyzedRoute ?? 0;
	// One selected route drives the page browser, the navigation, the visit and the archived page.
	const route = chosenRoute !== null && chosenRoute < routes.length ? chosenRoute : analyzedRoute;
	const walked = routes[route];
	const headlineRoute = route === analyzedRoute;
	// The download the case records was offered on its headline page, so only that route's visit shows it.
	const offeredDownload = headlineRoute ? website?.offeredDownload : undefined;
	const hasNavigation = routes.some((candidate) => candidate.hops.length > 0);
	const runsToShow = submission ? selectDisplayAnalysisRuns(submission.analysisRuns) : [];
	const reports = submission?.reports ?? [];
	// A report accepted before route resolution still counts, so the badge
	// never says zero while the tab shows its queued state.
	const reportCount = reports.reduce((count, report) => count + Math.max(1, report.routes.length), 0);

	const liveVisit = useLiveVisit(id, isRunning && submission?.kind === "website");
	// Every route's reported sites and deceptive funnels: the verdict covers the whole case, whichever route is shown.
	const confirmedSites = reportedSites(routes);
	const funnels = deceptiveFunnels(routes);

	const targetName =
		submission?.data.kind === "website"
			? websiteSiteName(submission.data.website?.url)
			: (submission?.data.email?.subject as string | undefined) || "Untitled Submission";

	const submissionArtifacts = submission?.artifacts ?? [];
	// The archived page: the selected route's judged page, which on the analyzed route is the case's headline page; a
	// route whose page has no archive falls back to the headline page, and a case without one to its first capture.
	const analyzed = website ? analyzedPage(website) : undefined;
	const routeAnalyzed = website ? analyzedPage({ routes, analyzedRoute: route }) : undefined;
	const archiveCandidates: Array<{ page: CapturePage; url: string }> = website
		? [...[routeAnalyzed, analyzed].flatMap((candidate) => (candidate ? [{ page: candidate.page, url: candidate.hop.url }] : [])), { page: { route: analyzedRoute, step: 0 }, url: website.url }]
		: [];
	const archivedPage = archiveCandidates
		.map((candidate) => ({ ...candidate, mhtml: latestArtifactNamed(submissionArtifacts, websiteCaptureFileNames(candidate.page).mhtml) }))
		.find((candidate) => candidate.mhtml);
	const websiteMhtml = archivedPage?.mhtml;
	const emailScreenshot = submission?.kind === "email" ? latestArtifactNamed(submissionArtifacts, "mail.png") : undefined;
	const emailEml = submissionArtifacts.find(isEmlArtifact);
	const websiteArchive = useArchivedHtml("website", submission?.kind === "website", websiteMhtml?.id);
	const emailArchive = useArchivedHtml("email", submission?.kind === "email", emailEml?.id);
	const canRetryAnalysis = Boolean(submission && canAnalyzeAgain(submission, reportCount, website ? Boolean(website.url) : Boolean(emailEml?.id)));
	// Only the email image shown beside the facts is left out of the files; a website's screenshots are files.
	const artifacts = submissionArtifacts.filter((x) => x !== emailScreenshot);
	const visitPages = routePages(route, walked, submissionArtifacts);

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

	// Mirrors what retryWebsiteAnalysis reuses: a judged capture is never judged again, a failed one is reused.
	const retryHint = submission.kind === "website"
		? websiteCloaking?.outcome === "unresolved"
			? "Visits the site again, including from the residential exit; it will not create a duplicate report."
			: isInvalid
				? "Visits the site again; it will not create a duplicate report."
				: "Reuses the captured website archive when available; it will not create a duplicate report."
		: "Analyzes the original email again; it will not create a duplicate report.";
	const analyzeAgain = { offered: canRetryAnalysis, running: retrying, error: retryError, hint: retryHint, onStart: retryAnalysis };
	const retried = retryCountLabel(submission.retries.count);
	// The case's outcome: its verdict, or why it was not reported with the way to analyze it again.
	const outcome = isReported ? (
		<VerdictPanel sites={confirmedSites} funnels={funnels} routeCount={routes.length} onShowRoute={setChosenRoute} reports={reports} caseId={id} submittedSite={targetName ?? null} reportCount={reportCount} joinedCases={reports.every((report) => report.submissionId !== null && String(report.submissionId) !== id) ? [...new Set(reports.map((report) => String(report.submissionId)))] : []} info={submission.info} onShowReports={() => setTab("reports")} />
	) : isInvalid ? (
		<OutcomePanel
			title="Not reported"
			info={submission.info || (submission.kind === "email" ? "The email was judged not to be phishing; no report was created." : "No reportable phishing or malware evidence was found; no report was created.")}
			analyzeAgain={analyzeAgain}
		/>
	) : isFailed ? (
		<OutcomePanel title="Failure reason" info={submission.info || "The analysis did not complete."} analyzeAgain={analyzeAgain} />
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
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
							{formatUtcDateTime(submission.createdAt) ?? "Unknown time"}
						</Badge>
						{retried ? (
							<span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground" title={`Last analyzed again ${formatUtcDateTime(submission.retries.lastAt) ?? ""}`}>
								<RotateCcw className="h-3 w-3" />
								{retried}
							</span>
						) : null}
						<SubmissionStatus status={submission.status} reportedAs={caseReportedAs(submission.data)} />
					</div>
				</div>
			</header>

			{submission.campaigns.map((campaign) => <CampaignLink key={campaign.id} campaign={campaign} locale={locale} />)}

			{/* On a phone the side column follows the whole page: the outcome comes first instead, the side column keeps it on wide screens. */}
			{outcome ? <div className="lg:hidden">{outcome}</div> : null}

			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
				<div className="min-w-0 space-y-6">
					{routes.length > 1 ? <RouteSelector routes={routes} selected={route} submittedSite={targetName} onSelect={setChosenRoute} /> : null}
					{website ? (
						// Keyed by route: a newly picked route opens on its own judged page, not the index picked on another.
						<SiteVisitBrowser key={route} running={isRunning} pages={visitPages} initialPage={routeAnalyzed?.page.step} live={liveVisit} fallbackUrl={website.url ?? ""} openAction={openSite} />
					) : null}
					{submission.data.kind === "email" && <EmailFacts email={submission.data.email} />}
					<Tabs value={tab} onValueChange={setTab} className="w-full min-w-0">
						<TabsList className="h-auto max-w-full flex-wrap justify-start">
							{submission.kind === "email" ? <TabsTrigger value="email">Email</TabsTrigger> : null}
							<TabsTrigger value="runs">Analysis</TabsTrigger>
							{submission.kind === "website" && hasNavigation ? <TabsTrigger value="navigation">Navigation</TabsTrigger> : null}
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
									subtitle={`Captured page: ${archivedPage!.url}${routes.length > 1 ? ` · ${routeLabel(archivedPage!.page.route)}` : ""}`}
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
							<SubmissionReports reports={reports} caseId={id} {...(website?.investigation ? { investigation: website.investigation } : {})} />
						</TabsContent>
						{website && hasNavigation ? (
							<TabsContent value="navigation" className="space-y-2 mt-4">
								{website.rotation ? <RotationNote rotation={website.rotation} onSelect={setChosenRoute} /> : null}
								{walked ? <NavigationTab route={route} walked={walked} headline={headlineRoute} website={website} artifacts={submissionArtifacts} /> : null}
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

				<aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6">
					{outcome ? <div className="hidden lg:block">{outcome}</div> : null}
					{website ? (
						<SiteVisitTimeline running={isRunning} visit={walked?.visit} offeredDownload={offeredDownload} live={liveVisit} pageCount={visitPages.length} routeName={routes.length > 1 ? routeLabel(route) : undefined} />
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

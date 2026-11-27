import { ExternalLink } from "lucide-react";
import { ExternalLinkConfirm } from "@/components/ExternalLinkConfirm";
import { OfferedFile } from "@/components/OfferedFile";
import { Badge } from "@/components/ui/badge";
import { CANARY_FIELD_LABEL, describeDataEntryField, revisitWording } from "@/lib/website/types";
import { chainHopBodyFileName, isPageHop, latestArtifactNamed, routePage, websiteCaptureFileNames } from "@/lib/website/visit/capture_files";
import type { WebsiteRoute } from "@/lib/website/types";
import type { SubmissionDetail } from "@/lib/submissions/details";
import { cn } from "@/lib/util/cn";
import { assessmentsByHop, findingLabel, siteRuns, type NavigationHop, type SiteAssessment, type SiteRun, type WebsiteData } from "./helpers";

type Artifacts = SubmissionDetail["artifacts"];

/** How the hop answered: a redirect, a page that sent the visitor on by script, or a page that was shown. */
function hopRole(hop: NavigationHop, headlineHopIndex: number | undefined): string {
	if (hop.index === headlineHopIndex) return "Page captured, the case's headline page";
	if (hop.contentCaptured) return "Last page shown, captured";
	if (hop.visitorStep) return "Page captured, the visit moved on";
	if (hop.revisit) return `Page captured, ${revisitWording(hop.revisit).cause}`;
	if (hop.status !== null && hop.status >= 300 && hop.status < 400) return "Redirect response only";
	return hop.redirectTo ? "Sent the visitor on by script" : "Response only";
}

/** The evidence files of one hop of route `route`: the raw response it was answered with, and the capture of the page it showed. */
function HopFiles({ route, hop, hops, artifacts }: { route: number; hop: NavigationHop; hops: readonly NavigationHop[]; artifacts: Artifacts }) {
	const page = isPageHop(hop) ? websiteCaptureFileNames(routePage(route, hops, hop)) : undefined;
	const files = [
		{ label: "Raw response", artifact: hop.bodyCaptured ? latestArtifactNamed(artifacts, chainHopBodyFileName(route, hop.index)) : undefined },
		{ label: "Screenshot", artifact: page && (latestArtifactNamed(artifacts, page.stampedScreenshot) ?? latestArtifactNamed(artifacts, page.screenshot)) },
		{ label: "Archive (MHTML)", artifact: page && latestArtifactNamed(artifacts, page.mhtml) },
		{ label: "Evidence manifest", artifact: page && latestArtifactNamed(artifacts, page.manifest) },
	].filter((file) => file.artifact);
	if (!files.length) return null;
	return (
		<div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
			{files.map(({ label, artifact }) => (
				<a key={label} href={`/api/artifacts/${artifact!.id}`} download={artifact!.name ?? undefined} className="font-medium text-primary hover:underline">{label}</a>
			))}
		</div>
	);
}

/**
 * One response of the route. `headlineHopIndex` is the case's headline page
 * when this is its route: the gate, warning and download the case records
 * belong to that page alone, not to the judged page of another route.
 */
function HopItem({ route, hop, hops, headlineHopIndex, website, artifacts }: { route: number; hop: NavigationHop; hops: readonly NavigationHop[]; headlineHopIndex: number | undefined; website: WebsiteData; artifacts: Artifacts }) {
	const { verificationGate, providerWarning, offeredDownload } = website;
	const analyzed = hop.index === headlineHopIndex;
	return (
		<li className="relative space-y-1 py-1.5 pl-4">
			<span aria-hidden className={cn("absolute -left-[5px] top-3 h-2.5 w-2.5 rounded-full border bg-background", isPageHop(hop) && "border-foreground/60 bg-foreground/60")} />
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 space-y-1">
					<div className="break-all font-mono text-xs">{hop.url}</div>
					<div className="text-xs text-muted-foreground">
						HTTP {hop.status ?? "unknown"}
						{hop.receivedAt ? <> · <time dateTime={hop.receivedAt} className="tabular-nums">{hop.receivedAt.slice(11, 23)} UTC</time></> : null}
						{" · "}{hopRole(hop, headlineHopIndex)}
					</div>
					{hop.visitorStep && hop.redirectTo ? (
						<div className="text-xs text-muted-foreground">
							{hop.visitorStep.submitted.length
								? <>The visit entered the made-up {hop.visitorStep.submitted.map((field) => CANARY_FIELD_LABEL[field]).join(", ")} here; it then showed {hop.redirectTo}</>
								: <>The visit moved on to {hop.redirectTo}</>}
						</div>
					) : hop.revisit && hop.redirectTo ? (
						<div className="text-xs text-muted-foreground">Opened again {revisitWording(hop.revisit).opened}, it shows {hop.redirectTo}</div>
					) : hop.redirectTo ? <div className="break-all text-xs text-muted-foreground">Leads to {hop.redirectTo}</div> : null}
					{verificationGate && analyzed ? (
						<div className="text-xs text-muted-foreground">Behind the page's own “{verificationGate.label}” gate, clicked to reveal it</div>
					) : null}
					{providerWarning && analyzed ? (
						<div className="text-xs text-muted-foreground">{providerWarning.provider} shows its “{providerWarning.warning}” warning before this page; the visit proceeded past it</div>
					) : null}
					{offeredDownload && analyzed ? (
						<div className="space-y-0.5 text-xs text-muted-foreground">
							<div>Offers <OfferedFile download={offeredDownload} />, downloaded by the visit and inspected without running it</div>
							<div className="font-mono">SHA-256 {offeredDownload.sha256}</div>
							{offeredDownload.inspection.browserExtension ? (
								<div>Browser extension “{offeredDownload.inspection.browserExtension.name}” with permissions {[...offeredDownload.inspection.browserExtension.permissions, ...offeredDownload.inspection.browserExtension.hostPermissions].join(", ")}</div>
							) : null}
						</div>
					) : null}
					<HopFiles route={route} hop={hop} hops={hops} artifacts={artifacts} />
				</div>
				<ExternalLinkConfirm
					href={hop.url}
					description="This opens this exact URL; your browser may follow its redirects."
					trigger={<button type="button" className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-primary" aria-label={`Open hop ${hop.index + 1}`}><ExternalLink className="h-4 w-4" /></button>}
				/>
			</div>
		</li>
	);
}

/** The site's verdict: its finding, and the evidence of the page it rests on where that page is in this run. */
function SiteVerdict({ run, assessment }: { run: SiteRun; assessment: SiteAssessment | undefined }) {
	const finding = assessment?.finding;
	const reportable = finding === "phishing" || finding === "malware";
	const label = findingLabel(assessment);
	const judgedHere = assessment?.judgedHopIndex !== undefined && run.hops.some((hop) => hop.index === assessment.judgedHopIndex);
	// A site that showed no page of its own; a case judged before verdicts named their page still shows its pages.
	const passedThrough = !run.hops.some(isPageHop);
	return (
		<div className="space-y-1">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-sm font-medium">{run.site}</span>
				{label ? <Badge variant="outline" className={cn("text-[10px] font-medium", reportable ? "border-destructive/30 bg-destructive/5 text-destructive" : "text-muted-foreground")}>{passedThrough && finding === "insufficient_evidence" ? "Only sent the visitor on, no page of its own" : label}</Badge> : null}
			</div>
			{judgedHere && assessment?.evidenceQuote ? <blockquote className="border-l-2 pl-2 text-xs text-muted-foreground">“{assessment.evidenceQuote}”</blockquote> : null}
			{judgedHere && assessment?.collectionFields?.length ? (
				<div className="text-xs text-muted-foreground">Collects data through: {assessment.collectionFields.map((field) => `“${describeDataEntryField(field)}”`).join(", ")}</div>
			) : null}
			{judgedHere && assessment?.rejectedClaim ? <div className="text-xs text-muted-foreground">Classifier&apos;s finding not corroborated: {assessment.rejectedClaim}</div> : null}
		</div>
	);
}

/**
 * One route's whole chain, site by site: every response with its evidence
 * files (named after the route), and each site's verdict. `headline` marks the
 * route of the case's headline page.
 */
export function NavigationTab({ route, walked, headline, website, artifacts }: { route: number; walked: WebsiteRoute; headline: boolean; website: WebsiteData; artifacts: Artifacts }) {
	const assessments = assessmentsByHop(walked);
	const headlineHopIndex = headline ? walked.analyzedHopIndex : undefined;
	return (
		<>
			<p className="text-xs text-muted-foreground">Every response of the visit, across every site it passed. Each site is judged on the pages it showed itself; a site that only redirected is never given the verdict of where it led.</p>
			<ol className="space-y-3">
				{siteRuns(walked.hops).map((run) => (
					<li key={`${run.hops[0]!.index}:${run.site}`} className="space-y-2 rounded border bg-background p-3">
						<SiteVerdict run={run} assessment={assessments.get(run.hops[0]!.index)} />
						<ol className="ml-1 border-l">
							{run.hops.map((hop) => <HopItem key={`${hop.index}:${hop.url}`} route={route} hop={hop} hops={walked.hops} headlineHopIndex={headlineHopIndex} website={website} artifacts={artifacts} />)}
						</ol>
					</li>
				))}
			</ol>
		</>
	);
}

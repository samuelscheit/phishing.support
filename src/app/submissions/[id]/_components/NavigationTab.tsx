import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { ExternalLinkConfirm } from "@/components/ExternalLinkConfirm";
import { CANARY_FIELD_LABEL, describeDataEntryField, revisitWording } from "@/lib/website_types";
import { cn } from "@/web_lib/util";
import { hopFindingLabel, type NavigationHop, type SiteAssessment, type WebsiteData } from "./helpers";

function HopItem({ hop, assessment, website }: { hop: NavigationHop; assessment: SiteAssessment | undefined; website: WebsiteData }) {
	const { verificationGate, providerWarning, offeredDownload, redirectSubmissionId } = website;
	const finding = assessment?.finding;
	const findingLabel = hopFindingLabel(assessment);
	return (
		<li className="rounded border bg-background p-2">
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
}

/** The redirect chain of the visit, each hop with its finding. */
export function NavigationTab({ hops, assessments, website }: { hops: NavigationHop[]; assessments: Map<number, SiteAssessment>; website: WebsiteData }) {
	return (
		<>
			<p className="text-xs text-muted-foreground">Redirects and followed links within one site belong to that site and share the finding of the page they lead to. A destination on another host is never attributed to the URL that redirected to it.</p>
			<ol className="space-y-2">
				{hops.map((hop) => <HopItem key={`${hop.index}:${hop.url}`} hop={hop} assessment={assessments.get(hop.index)} website={website} />)}
			</ol>
		</>
	);
}

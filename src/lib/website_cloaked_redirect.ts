import { SubmissionsEntity } from "./db/entities/submissions";
import { createWebsiteSubmission } from "./submissions/website";
import type { ReporterMetadata } from "./request_metadata";
import { websiteSite } from "./website_site";
import { capturedHostNavigation } from "./website_report_hops";
import type { getInfo } from "./website_info";
import type { WebsiteAnalysisDependencies, WebsiteCapture } from "./website_analysis_types";
import type { WebsiteCloakedDestination, WebsiteCloaking, WebsiteNavigationHop } from "./website_types";

/** What the case says when every network was turned away by the flow's destination. */
export function cloakedDestinationInfo(cloaked: WebsiteCloakedDestination): string {
	const untried = cloaked.notTried.length ? ` ${cloaked.notTried.map(({ network, reason }) => `The ${network} could not be tried: ${reason}.`).join(" ")}` : "";
	return `The site's flow leads to ${cloaked.host}, which answered every network we tried (${cloaked.answered.join(", ")}) with an empty response and sent the visit back; no report was created.${untried}`;
}

/**
 * A capture that ended on another site belongs to that site: it opens that
 * site's own case with the captured evidence and its same-site navigation, as
 * if the destination had been submitted directly. The submitted site gets no
 * finding of its own; its navigation links to the destination case. `via`
 * names the step of the submitted site's flow that led there (its button, its
 * link, its field), when the capture had to take one.
 */
export async function handOffRedirectedCapture(params: {
	submissionId: bigint;
	url: string;
	whois: Awaited<ReturnType<typeof getInfo>>;
	archive: WebsiteCapture;
	capturedHop: WebsiteNavigationHop;
	reporter: ReporterMetadata;
	dependencies: WebsiteAnalysisDependencies;
	via?: string;
	/** Analyzes the destination's case; the orchestrator passes itself in. */
	analyze: Parameters<typeof createWebsiteSubmission>[1];
}) {
	const { submissionId, url, whois, archive, capturedHop, via } = params;
	const navigationHops = capturedHostNavigation(archive.navigationHops, capturedHop);
	const redirectSubmissionId = await createWebsiteSubmission({
		url: navigationHops[0]!.url,
		source: `redirect:${submissionId.toString()}`,
		mhtmlSnapshot: archive.mhtml,
		archivedUrl: archive.url,
		navigationHops,
		screenshotSnapshot: archive.screenshotPng,
		...(archive.route ? { captureRoute: archive.route } : {}),
		verificationGate: archive.verificationGate,
		kitResources: archive.kitResources,
		hiddenFrames: archive.hiddenFrames,
		device: archive.device,
		...params.reporter,
	}, params.analyze);
	const destination = websiteSite(capturedHop.url);
	await SubmissionsEntity.update(submissionId, {
		status: "redirected",
		info: archive.cloaking?.outcome === "detected"
			? `${url} cloaks: ${archive.cloaking.detail}. ${destination} is analyzed in its own case. ${decoyDestinationClause(url)}`
			: archive.cloaking?.outcome === "uniform"
				? `${archive.cloaking.detail}; that site is analyzed in its own case. ${decoyDestinationClause(url)}`
				: `${url} ${via ? `sends visitors on to ${destination} through ${via}` : `redirects to ${destination}`}; that site is analyzed and reported in its own case.`,
		data: {
			kind: "website",
			website: {
				url,
				whois,
				archiveUrl: archive.url,
				navigationHops: archive.navigationHops,
				redirectSubmissionId: redirectSubmissionId.toString(),
				...(archive.cloaking ? { cloaking: archive.cloaking } : {}),
			},
		},
	});
	// The destination may already have a verdict: an earlier case for it, or a fast analysis.
	await settleCloakedRedirect(submissionId);
}

function decoyDestinationClause(url: string): string {
	return `If it shows nothing reportable, ${url} is treated as a cloaker that turned every route away.`;
}

/**
 * A cloaking page handed off to where it sent the residential exit waits on
 * that site's verdict. The residential exit reached either the same site as
 * Tor (`uniform`) or another one (`detected`): a kit on its own domain, or just
 * another decoy from a cloaker that picks a random news site per visit
 * (docusign.alt3-doc3ea7-v2.sbs). A harmless destination (Wikipedia, a news
 * front page) is the decoy of a cloaker that turned every route away, not where
 * the page leads its real visitors; the submitted case then fails as suspected
 * cloaking so a retry visits it again.
 */
async function settleCloakedRedirect(submissionId: bigint): Promise<void> {
	const submission = await SubmissionsEntity.get(submissionId);
	const website = submission?.status === "redirected" && submission.data.kind === "website" ? submission.data.website : undefined;
	if (!website?.cloaking || !website.redirectSubmissionId) return;
	const destination = await SubmissionsEntity.get(BigInt(website.redirectSubmissionId));
	if (destination?.status !== "invalid") return;
	const cloaking = { outcome: "unresolved" as const, detail: `${website.cloaking.detail}, which shows nothing reportable` };
	await SubmissionsEntity.update(submissionId, {
		status: "failed",
		info: cloakingSuspectedInfo(cloaking),
		data: { kind: "website", website: { ...website, cloaking } },
	});
}

export function cloakingSuspectedInfo(cloaking: WebsiteCloaking): string {
	return `Cloaking suspected: ${cloaking.detail}. No verdict or report was made from the decoy; retry to visit the site again.`;
}

/** Settle the submitted cases that were handed off to this destination and wait on its verdict. */
export async function settleCloakedRedirectsTo(destinationId: bigint): Promise<void> {
	for (const submission of await SubmissionsEntity.listRedirectedTo(destinationId)) {
		await settleCloakedRedirect(submission.id);
	}
}

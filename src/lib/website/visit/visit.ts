import { FABRIC_EGRESS_LABEL, type FabricEgress } from "../../browser/fabric";
import type { ArchiveWebsiteOptions } from "../archive/types";
import { errorText } from "../../util/error_text";
import type { WebsiteCloakedDestination, WebsiteRevisit, VisitDataSent, WebsiteKitResource, WebsiteNavigationHop, WebsiteSiteAssessment, WebsiteSiteClassification, WebsiteVisitRecord } from "../types";
import { cloakedDestination, WEBSITE_FLOW_EGRESS } from "../archive/cloaking";
import { VISIT_BUDGET_MS } from "../../site_visit/visit_task";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import type { getInfo } from "../info/info";
import { runStreamedAnalysisRun } from "../../analysis/run";
import { publishEvent } from "../../event/event_transport";
import { defaultResponseModel } from "../../openai/client";
import { offeredDownloadOf } from "./offered_download";
import { analyzedCaptureStep } from "./capture_files";
import { isSameWebsite } from "../info/site";
import { createExfiltrationCanaries } from "../../exfiltration/canaries";
import { discoverExfiltrationBackends } from "../../exfiltration/analysis";
import type { CapturedNetworkRequest, ExfiltrationBackend, ExfiltrationCanaries } from "../../exfiltration/types";
import { taskAgentVisit } from "../../site_visit/agent";
import { visitNavigation, visitPages, type VisitPage } from "../../site_visit/evidence";
import type { SiteVisitRecording } from "../../site_visit/visit";
import type { NarrativeVisitPage } from "../analysis/narrative";
import { isWebPage } from "../../network/web_page";
import { lookupDomainRegistration } from "../info/domain_registration";
import { buildWebsiteClassificationInput, validateWebsiteSiteClassification, websiteMobileHandoff, WEBSITE_CLASSIFICATION_FORMAT, type WebsiteEvidenceArchive } from "../analysis/classification";
import { emitStep } from "./progress";
import { capturedArchiveHop, isReportable, websiteSiteAssessments } from "../info/report_hops";
import { saveVisitEvidence, websiteEvidence } from "../analysis/evidence";
import { challengeInconclusive, CHALLENGE_RETRY_EGRESS, continuedRevisit } from "./revisit";
import type { WebsiteAnalysisDependencies, WebsiteCapture } from "../analysis/analysis_types";

/** Every page's kit files, once per hash. */
function mergedKitResources(...captures: WebsiteCapture[]): WebsiteKitResource[] {
	return captures.flatMap((capture) => capture.kitResources ?? [])
		.filter((resource, index, all) => all.findIndex((other) => other.sha256 === resource.sha256) === index);
}


async function classifyCapturedPage(submissionId: bigint, hop: WebsiteNavigationHop, archive: WebsiteEvidenceArchive, dependencies: WebsiteAnalysisDependencies) {
	// A script, stylesheet or data file shown as text is not a page anyone is lured by; its source names paths, not deceptions.
	if (!isWebPage(hop.contentType)) {
		return { classification: { finding: "insufficient_evidence", rejectedClaim: `the captured address serves a file (${hop.contentType}), not a web page a visitor is shown` } satisfies WebsiteSiteClassification, mobileHandoff: false };
	}
	const { result } = await runStreamedAnalysisRun({
		submissionId,
		analysisKind: "classification",
		options: {
			model: defaultResponseModel,
			input: buildWebsiteClassificationInput(hop, archive, await (dependencies.domainRegistration ?? lookupDomainRegistration)(new URL(hop.url).hostname)),
			// The classifier checks a brand's official domains when the page's domain is not the one it knows.
			tools: [{ type: "web_search" }],
			text: { format: WEBSITE_CLASSIFICATION_FORMAT, verbosity: "low" },
			stream: true,
		},
	}, { client: dependencies.analysisClient });
	return {
		classification: validateWebsiteSiteClassification(result.output_parsed, archive.text.toString("utf-8"), archive.html.toString("utf-8"), archive.hiddenFrames, archive.offeredDownload, hop.url),
		mobileHandoff: websiteMobileHandoff(result.output_parsed),
	};
}

/** The visit as the case keeps it: what the agent did and every request that carried synthetic values. */
function visitRecord(recording: SiteVisitRecording<unknown>, pages: ReadonlyArray<VisitPage<unknown>>): WebsiteVisitRecord {
	const { agent } = recording;
	return {
		outcome: agent.outcome,
		...(agent.failure ? { failure: agent.failure } : {}),
		...(agent.report ? { report: agent.report } : {}),
		actions: agent.actions.slice(0, MAX_RECORDED_ACTIONS).map(({ kind, text }) => ({ kind, text })),
		dataSent: pages.flatMap((page) => page.dataSent).slice(0, MAX_RECORDED_DATA_SENT),
		downloadFailures: recording.downloadFailures,
	};
}

const MAX_RECORDED_ACTIONS = 80;
const MAX_RECORDED_DATA_SENT = 40;

/** What one visit of the site found: the page whose verdict is the case's, and the evidence around it. */
export type WebsiteVisitResult = {
	archive: WebsiteCapture;
	capturedHop: WebsiteNavigationHop;
	classification: WebsiteSiteClassification;
	assessments: WebsiteSiteAssessment[];
	/** Requests of the whole visit that sent synthetic values to another site. */
	dataDrops: VisitDataSent[];
	backends: ExfiltrationBackend[];
	requests: CapturedNetworkRequest[];
	canaries: ExfiltrationCanaries;
	record: WebsiteVisitRecord;
	/** Every page the visit judged, in the order shown, for the narrative. */
	pages: NarrativeVisitPage[];
	/** Set when the visit could not finish and nothing it saw is reportable: no verdict, another visit may. */
	inconclusive?: string;
	/** Set when the visit's flow went on to another site before showing anything reportable on this one. */
	handedOff?: boolean;
	/** Pages after the judged one, kept as evidence only. */
	laterPages?: Array<{ url: string; step: number }>;
	/** Set when the flow's destination answered every network tried with nothing and sent the visit back. */
	cloakedDestination?: WebsiteCloakedDestination;
};

/**
 * Walk the site with the visiting agent from the captured page, as its
 * victim would, then judge what the visit recorded: each page in the order
 * it was shown, with the synthetic values it sent off and the file it made
 * the visitor download. The first reportable page of the submitted site is
 * the case's finding. A flow that reaches another site before that belongs
 * to that site, exactly as a redirect does. A site that turns desktops away
 * is visited again as a phone.
 */
export async function visitWebsite(params: {
	submissionId: bigint;
	url: string;
	whois: Awaited<ReturnType<typeof getInfo>>;
	archive: WebsiteCapture;
	dependencies: WebsiteAnalysisDependencies;
	capture: (options: ArchiveWebsiteOptions) => Promise<WebsiteCapture>;
	/** The revisit that led to this capture, when it is one: the earlier visit's hops, the page it opened again, and why. */
	revisit?: { hops: WebsiteNavigationHop[]; from: WebsiteNavigationHop; revisit: WebsiteRevisit };
	/** A visit before this one was blocked by a challenge and opened again from another network; it is not repeated twice. */
	challengeRetried?: boolean;
	/** The network every later capture of the visit uses: the one a challenge let through. */
	egress?: FabricEgress;
	/** The walks of this flow so far when its destination cloaked them: the networks that were turned away, those that could not be tried, and when the first walk began. */
	cloaked?: { answered: FabricEgress[]; notTried: Array<{ network: string; reason: string }>; startedAt: number };
}): Promise<WebsiteVisitResult> {
	const { submissionId, url, whois, dependencies, capture } = params;
	const first = params.archive;
	const device = first.device ? { device: first.device } : {};
	const route = params.egress ? { egress: params.egress } : {};
	await emitStep(submissionId, "site_visit", 45);
	const flowStartedAt = Date.now();
	// A page from a stored capture is loaded live first: the visit walks the live site.
	const walked = first.session ? first : await capture({ url: first.url, ...device, ...route });
	const { session } = walked;
	const canaries = createExfiltrationCanaries();
	const agent = dependencies.visitAgent ?? taskAgentVisit();
	const empty: SiteVisitRecording<WebsiteCapture> = { startedAt: new Date(), steps: [], requests: [], downloads: [], downloadFailures: [], agent: { outcome: "failed", failure: "The page could not be loaded live for the visit.", actions: [] } };
	const recording = session
		? await session.visit({ canaries, agent, live: (event) => { void publishEvent(`run:${submissionId}`, event); } }) as SiteVisitRecording<WebsiteCapture>
		: empty;

	const pages = visitPages<WebsiteCapture>(first, recording, canaries);
	const record = visitRecord(recording, pages);
	// A visit that walked the live site is evidence of how the values were entered and where they went.
	if (session) await saveVisitEvidence({ submissionId, url, device: first.device, recording, pages, canaries, dependencies });
	const dataDrops = pages.flatMap((page) => page.dataSent.filter((sent) => !sent.sameSite));
	const backends = discoverExfiltrationBackends({ requests: recording.requests, canaries, pageUrl: url });
	const base = { dataDrops, backends, requests: recording.requests, canaries, record };

	// Each page with the navigation that led to it, what it sent, and the file it delivered.
	const lookups = dependencies.downloadLookups;
	const prefix = params.revisit ? continuedRevisit(params.revisit) : [];
	const archives: WebsiteCapture[] = [];
	for (const [position, page] of pages.entries()) {
		const [file] = page.downloads;
		const offeredDownload = file ? await offeredDownloadOf(file, page.archive.url, lookups) : undefined;
		const navigation = visitNavigation(pages.slice(0, position + 1));
		archives.push({
			...page.archive,
			requestedUrl: first.requestedUrl,
			navigationHops: [...prefix, ...navigation].map((hop, index) => ({ ...hop, index })),
			kitResources: mergedKitResources(...pages.slice(0, position + 1).map((shown) => shown.archive)),
			...(first.cloaking ? { cloaking: first.cloaking } : {}),
			...(first.providerWarning ? { providerWarning: first.providerWarning } : {}),
			...(first.device ? { device: first.device } : {}),
			...(offeredDownload ? { offeredDownload } : {}),
			...(page.dataSent.length ? { dataSent: page.dataSent } : {}),
		});
	}

	// The narrative reads every page shown up to the analyzed one.
	const narrativePages = (until: number): NarrativeVisitPage[] => archives.slice(0, until + 1).map((page) => ({
		url: page.url,
		...(pageTitle(page.html) ? { title: pageTitle(page.html) } : {}),
		text: page.text.toString("utf-8"),
	}));

	// Judge the pages in the order they were shown.
	const assessments: WebsiteSiteAssessment[] = [];
	let asksForPhone = recording.agent.report?.asksForPhone === true;
	for (const [position, archive] of archives.entries()) {
		const capturedHop = capturedArchiveHop(archive);
		// Every page but the captured one is a step of the case with its own evidence
		// package; a phone revisit's first page is a step too.
		if (position > 0 || params.revisit) await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await websiteEvidence(submissionId, url, archive, dependencies) });
		if (!isSameWebsite(capturedHop.url, url)) {
			return { ...base, archive, capturedHop, classification: { finding: "insufficient_evidence" }, assessments, pages: narrativePages(position), handedOff: true };
		}
		await emitStep(submissionId, "classification", Math.min(70, 50 + position * 4));
		const classified = await classifyCapturedPage(submissionId, capturedHop, archive, dependencies);
		asksForPhone ||= classified.mobileHandoff;
		// The page's own hops (a redirect on its site, then the page) share its finding.
		assessments.push(...websiteSiteAssessments(archive.navigationHops.slice(assessments.length), capturedHop.index, classified.classification));
		const last = position === archives.length - 1;
		if (isReportable(classified.classification) || last) {
			// A destination that answered empty and sent the visit back turned this network away:
			// the whole flow is walked again through the others, the gate passed again in each.
			const cloak = isReportable(classified.classification) ? undefined : cloakedDestination(visitNavigation(pages), url);
			if (cloak) {
				const answered = [...(params.cloaked?.answered ?? []), walked.egress ?? params.egress ?? WEBSITE_FLOW_EGRESS[0]!];
				const notTried = [...(params.cloaked?.notTried ?? [])];
				const startedAt = params.cloaked?.startedAt ?? flowStartedAt;
				const reopened = { ...capturedHop, url: first.url };
				for (const egress of WEBSITE_FLOW_EGRESS.filter((candidate) => !answered.includes(candidate) && !notTried.some(({ network }) => network === FABRIC_EGRESS_LABEL[candidate]))) {
					const network = FABRIC_EGRESS_LABEL[egress];
					if (Date.now() - startedAt >= (dependencies.cloakedFlowBudgetMs ?? VISIT_BUDGET_MS)) {
						notTried.push({ network, reason: "the time budget for walking the flow again was used up" });
						continue;
					}
					await emitStep(submissionId, "revisit_cloaked_destination", 72);
					// One capture browser at a time: the residential exit is a single connection.
					await session?.close();
					const retried = await capture({ url: first.url, ...device, egress }).catch((error: unknown) => {
						console.warn(`Walking ${first.url} again from the ${network} failed: ${errorText(error)}`);
						notTried.push({ network, reason: errorText(error) });
						return undefined;
					});
					if (retried) {
						return visitWebsite({ ...params, archive: retried, egress, cloaked: { answered, notTried, startedAt }, revisit: { hops: archive.navigationHops, from: reopened, revisit: { reason: "destination_cloaked", route: network, site: cloak.site } } });
					}
				}
				const record: WebsiteCloakedDestination = { host: cloak.host, site: cloak.site, answered: answered.map((egress) => FABRIC_EGRESS_LABEL[egress]), notTried };
				return { ...base, archive, capturedHop, classification: classified.classification, assessments, pages: narrativePages(position), cloakedDestination: record };
			}
			// A site that turns desktops away shows the phone something else.
			if (!isReportable(classified.classification) && asksForPhone && !first.device) {
				await emitStep(submissionId, "revisit_as_phone", 72);
				const phone = await capture({ url: first.url, device: "iphone", ...route });
				return visitWebsite({ ...params, archive: phone, revisit: { hops: archive.navigationHops, from: capturedHop, revisit: { reason: "phone", device: "iphone" } } });
			}
			// A challenge that would not clear for this network may let the residential exit through.
			// A capture that already came from there was decoyed or turned away everywhere else.
			const challenge = !isReportable(classified.classification) ? recording.agent.report?.blockedByChallenge : false;
			let unreached: string | undefined;
			if (challenge && !params.challengeRetried && walked.egress !== CHALLENGE_RETRY_EGRESS) {
				await emitStep(submissionId, "revisit_from_other_exit", 72);
				// One capture browser at a time: the residential exit is a single connection.
				await session?.close();
				const retried = await capture({ url: first.url, ...device, egress: CHALLENGE_RETRY_EGRESS }).catch((error: unknown) => {
					// The other network failing, whatever the reason, leaves the blocked visit's result.
					console.warn(`Revisiting ${first.url} from the ${FABRIC_EGRESS_LABEL[CHALLENGE_RETRY_EGRESS]} failed: ${errorText(error)}`);
					unreached = errorText(error);
					return undefined;
				});
				if (retried) {
					// The page reopened is the one the visit started at, which the blocked page was reached from.
					const reopened = { ...capturedHop, url: first.url };
					return visitWebsite({ ...params, archive: retried, challengeRetried: true, egress: CHALLENGE_RETRY_EGRESS, revisit: { hops: archive.navigationHops, from: reopened, revisit: { reason: "challenge", route: FABRIC_EGRESS_LABEL[CHALLENGE_RETRY_EGRESS] } } });
				}
			}
			// A visit that did not get past the site's challenge saw nothing of the site behind it.
			const inconclusive = isReportable(classified.classification) ? undefined
				: recording.agent.outcome !== "completed" ? recording.agent.failure ?? "The visiting agent did not finish the site's flow."
				: challenge ? challengeInconclusive(recording.agent.report!.stoppedReason, { retried: params.challengeRetried === true, unreached })
				: undefined;
			// The verdict needs no later page, but the evidence does: the form the values were
			// typed into and the pages after it show what the site took and where it went.
			const laterPages: Array<{ url: string; step: number }> = [];
			for (const later of archives.slice(position + 1)) {
				await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive: later, evidence: await websiteEvidence(submissionId, url, later, dependencies) });
				laterPages.push({ url: later.url, step: analyzedCaptureStep(later.navigationHops) });
			}
			return { ...base, archive, capturedHop, classification: classified.classification, assessments, pages: narrativePages(position), ...(inconclusive ? { inconclusive } : {}), ...(laterPages.length ? { laterPages } : {}) };
		}
	}
	throw new Error("A visit always has the captured page.");
}

/** The document's own title, as a visitor reads it in the tab. */
function pageTitle(html: Buffer): string | undefined {
	return html.toString("utf-8").match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

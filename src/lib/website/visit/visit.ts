import { FABRIC_EGRESS_LABEL, type FabricEgress } from "../../browser/fabric";
import type { ArchiveWebsiteOptions } from "../archive/types";
import { errorText } from "../../util/error_text";
import type { WebsiteCloakedDestination, WebsiteRevisit, VisitDataSent, WebsiteKitResource, WebsiteNavigationHop, WebsiteSiteAssessment, WebsiteSiteClassification, WebsiteVisitRecord } from "../types";
import { cloakedDestination, WEBSITE_CAPTURE_EGRESS } from "../archive/cloaking";
import { VISIT_BUDGET_MS } from "../../site_visit/visit_task";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import type { getInfo } from "../info/info";
import { runStreamedAnalysisRun } from "../../analysis/run";
import { publishEvent } from "../../event/event_transport";
import { defaultResponseModel } from "../../openai/client";
import { offeredDownloadOf } from "./offered_download";
import { isSameWebsite, websiteSite } from "../info/site";
import { createExfiltrationCanaries } from "../../exfiltration/canaries";
import { discoverExfiltrationBackends } from "../../exfiltration/analysis";
import type { CapturedNetworkRequest, ExfiltrationBackend, ExfiltrationCanaries } from "../../exfiltration/types";
import { taskAgentVisit } from "../../site_visit/agent";
import { visitNavigation, visitPages, type VisitPage } from "../../site_visit/evidence";
import type { SiteVisitRecording } from "../../site_visit/visit";
import type { NarrativeVisitPage } from "../analysis/narrative";
import { isWebPage } from "../../network/web_page";
import { lookupDomainRegistration } from "../info/domain_registration";
import { buildWebsiteClassificationInput, validateWebsiteSiteClassification, websiteClassificationFingerprint, websiteMobileHandoff, WEBSITE_CLASSIFICATION_FORMAT, type WebsiteEvidenceArchive } from "../analysis/classification";
import { emitStep } from "./progress";
import { analyzedCaptureStep, type CapturePage } from "./capture_files";
import { capturedArchiveHop, chainSiteAssessments, isReportable } from "../info/report_hops";
import { saveVisitEvidence, websiteEvidence } from "../analysis/evidence";
import { challengeInconclusive, CHALLENGE_RETRY_EGRESS, continuedRevisit } from "./revisit";
import type { WebsiteAnalysisDependencies, WebsiteCapture } from "../analysis/analysis_types";
import type { ReporterInstructions } from "../../submissions/instructions";

/** Every page's kit files, once per hash. */
function mergedKitResources(...captures: WebsiteCapture[]): WebsiteKitResource[] {
	return captures.flatMap((capture) => capture.kitResources ?? [])
		.filter((resource, index, all) => all.findIndex((other) => other.sha256 === resource.sha256) === index);
}


async function classifyCapturedPage(submissionId: bigint, hop: WebsiteNavigationHop, archive: WebsiteEvidenceArchive, dependencies: WebsiteAnalysisDependencies, analysisInstructions: string | undefined) {
	// A script, stylesheet or data file shown as text is not a page anyone is lured by; its source names paths, not deceptions.
	if (!isWebPage(hop.contentType)) {
		return { classification: { finding: "insufficient_evidence", rejectedClaim: `the captured address serves a file (${hop.contentType}), not a web page a visitor is shown` } satisfies WebsiteSiteClassification, mobileHandoff: false };
	}
	const { result } = await runStreamedAnalysisRun({
		submissionId,
		analysisKind: "classification",
		options: {
			model: defaultResponseModel,
			input: buildWebsiteClassificationInput(hop, archive, await (dependencies.domainRegistration ?? lookupDomainRegistration)(new URL(hop.url).hostname), analysisInstructions),
			// The classifier checks a brand's official domains when the page's domain is not the one it knows.
			tools: [{ type: "web_search" }],
			text: { format: WEBSITE_CLASSIFICATION_FORMAT, verbosity: "low" },
			stream: true,
		},
	}, { client: dependencies.analysisClient });
	return {
		classification: validateWebsiteSiteClassification(result.output_parsed, {
			text: archive.text.toString("utf-8"),
			html: archive.html.toString("utf-8"),
			url: hop.url,
			...(archive.hiddenFrames ? { hiddenFrames: archive.hiddenFrames } : {}),
			...(archive.offeredDownload ? { offeredDownload: archive.offeredDownload } : {}),
			...(archive.clipboardWrites ? { clipboardWrites: archive.clipboardWrites } : {}),
		}),
		mobileHandoff: websiteMobileHandoff(result.output_parsed),
	};
}

/** The visit as the case keeps it: what the agent did, every request that carried synthetic values, and what its pages copied. */
function visitRecord(recording: SiteVisitRecording<unknown>, pages: ReadonlyArray<VisitPage<unknown>>): WebsiteVisitRecord {
	const { agent } = recording;
	const clipboardWrites = pages.flatMap((page) => page.clipboardWrites);
	return {
		outcome: agent.outcome,
		...(agent.failure ? { failure: agent.failure } : {}),
		...(agent.report ? { report: agent.report } : {}),
		actions: agent.actions.slice(0, MAX_RECORDED_ACTIONS).map(({ kind, text }) => ({ kind, text })),
		dataSent: pages.flatMap((page) => page.dataSent).slice(0, MAX_RECORDED_DATA_SENT),
		downloadFailures: recording.downloadFailures,
		...(clipboardWrites.length ? { clipboardWrites } : {}),
	};
}

const MAX_RECORDED_ACTIONS = 80;
const MAX_RECORDED_DATA_SENT = 40;

/** A site of the chain whose page was found reportable: that page, its hop and its verdict. */
export type WebsiteChainSite = {
	archive: WebsiteCapture;
	capturedHop: WebsiteNavigationHop;
	classification: WebsiteSiteClassification;
	/** Requests that sent synthetic values to another site while a page of this site was shown. */
	dataDrops: VisitDataSent[];
};

/** A page the visit showed, as the narrative and the funnel read it: the hop that served it, when, and the page its capture files are named after. */
export type WebsiteShownPage = NarrativeVisitPage & { hopIndex: number; capturedAt: Date; page: CapturePage };

/** A site's verdict: the page it rests on and what that page was found to be. */
type SiteVerdict = { judgedHopIndex: number; classification: WebsiteSiteClassification };

/**
 * A visit opened again (as a phone, from another network): the earlier
 * visit's hops, the page it opened again, and why, with the pages it showed
 * and its sites' verdicts, which the case keeps for the hops they judged.
 */
type Revisit = { hops: WebsiteNavigationHop[]; from: WebsiteNavigationHop; revisit: WebsiteRevisit; pages: WebsiteShownPage[]; verdicts: ReadonlyMap<string, SiteVerdict> };

/** What one visit of the chain found: every site's verdict, the page the case's verdict rests on, and the evidence around it. */
export type WebsiteVisitResult = {
	/** The page the case's verdict rests on: the first reportable page, else the last page shown. */
	archive: WebsiteCapture;
	capturedHop: WebsiteNavigationHop;
	classification: WebsiteSiteClassification;
	/** The whole chain, response by response, through the last page shown. */
	chain: WebsiteNavigationHop[];
	/** One per hop of the chain: the verdict of its site. */
	assessments: WebsiteSiteAssessment[];
	/** Each site whose page was found reportable, in the order the visit reached them. */
	reportable: WebsiteChainSite[];
	backends: ExfiltrationBackend[];
	requests: CapturedNetworkRequest[];
	canaries: ExfiltrationCanaries;
	record: WebsiteVisitRecord;
	/** Every page the visit showed, in order, earlier visits of a revisit first. */
	pages: WebsiteShownPage[];
	/** Set when the visit could not finish and nothing it saw is reportable: no verdict, another visit may. */
	inconclusive?: string;
	/** Set when the flow's destination answered every network tried with nothing and sent the visit back. */
	cloakedDestination?: WebsiteCloakedDestination;
};

/**
 * Walk the chain with the visiting agent from the captured page, as its
 * victim would, across every site it leads to, then judge what the visit
 * recorded: each page in the order it was shown, with the synthetic values it
 * sent off and the file it made the visitor download. Each site's verdict is
 * its first reportable page, else its last page shown; a site already found
 * reportable is not judged again. A site that turns desktops away is visited
 * again as a phone.
 */
export async function visitWebsite(params: {
	submissionId: bigint;
	/** The route of the case this walk is: its files are named after it. */
	route: number;
	/**
	 * The networks a revisit of this walk may come from: a challenge's other
	 * exit, a cloaked destination's other networks. Every network by default;
	 * a sampled visit of a rotating link stays on the network it came from.
	 */
	networks?: readonly FabricEgress[];
	url: string;
	/** The reporter's instructions: the browser's for every visit of the walk, revisits too, the analysis's for each classification. */
	instructions?: ReporterInstructions;
	whois: Awaited<ReturnType<typeof getInfo>>;
	archive: WebsiteCapture;
	dependencies: WebsiteAnalysisDependencies;
	capture: (options: ArchiveWebsiteOptions) => Promise<WebsiteCapture>;
	/** The revisit that led to this capture, when it is one. */
	revisit?: Revisit;
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
	const empty: SiteVisitRecording<WebsiteCapture> = { startedAt: new Date(), steps: [], requests: [], downloads: [], downloadFailures: [], clipboardWrites: [], agent: { outcome: "failed", failure: "The page could not be loaded live for the visit.", actions: [] } };
	const recording = session
		? await session.visit({ canaries, agent, ...(params.instructions?.browser ? { instructions: params.instructions.browser } : {}), live: (event) => { void publishEvent(`run:${submissionId}`, event); } }) as SiteVisitRecording<WebsiteCapture>
		: empty;

	const pages = visitPages<WebsiteCapture>(first, recording, canaries);
	const record = visitRecord(recording, pages);
	// A visit that walked the live site is evidence of how the values were entered and where they went.
	if (session) await saveVisitEvidence({ submissionId, route: params.route, url, device: first.device, recording, pages, canaries, dependencies });
	const backends = discoverExfiltrationBackends({ requests: recording.requests, canaries, pageUrl: url });
	const base = { backends, requests: recording.requests, canaries, record };

	// Each page with the navigation that led to it, what it sent, and the file it delivered.
	const lookups = dependencies.downloadLookups;
	const prefix = params.revisit ? continuedRevisit(params.revisit) : [];
	const archives: WebsiteCapture[] = [];
	let hopsBefore = prefix.length;
	for (const [position, page] of pages.entries()) {
		const [file] = page.downloads;
		const offeredDownload = file ? await offeredDownloadOf(file, page.archive.url, lookups) : undefined;
		const navigation = visitNavigation(pages.slice(0, position + 1));
		// The page's own hops follow every hop before it in the chain; their bodies keep their place.
		const hopBodies = (page.archive.hopBodies ?? []).map(({ hopIndex, body }) => ({ hopIndex: hopIndex + hopsBefore, body }));
		hopsBefore += page.archive.navigationHops.length;
		archives.push({
			...page.archive,
			requestedUrl: first.requestedUrl,
			navigationHops: [...prefix, ...navigation].map((hop, index) => ({ ...hop, index })),
			...(hopBodies.length ? { hopBodies } : {}),
			kitResources: mergedKitResources(...pages.slice(0, position + 1).map((shown) => shown.archive)),
			...(first.cloaking ? { cloaking: first.cloaking } : {}),
			...(first.providerWarning ? { providerWarning: first.providerWarning } : {}),
			...(first.device ? { device: first.device } : {}),
			...(offeredDownload ? { offeredDownload } : {}),
			...(page.dataSent.length ? { dataSent: page.dataSent } : {}),
			...(page.clipboardWrites.length ? { clipboardWrites: page.clipboardWrites } : {}),
		});
	}

	// The narrative and the funnel read every page shown, the earlier visit's too.
	const shownPages: WebsiteShownPage[] = [
		...(params.revisit?.pages ?? []),
		...archives.map((page) => ({
			url: page.url,
			...(pageTitle(page.html) ? { title: pageTitle(page.html) } : {}),
			text: page.text.toString("utf-8"),
			hopIndex: capturedArchiveHop(page).index,
			capturedAt: page.archivedAt,
			page: { route: params.route, step: analyzedCaptureStep(page.navigationHops) },
		})),
	];

	// Judge the pages in the order they were shown, each site until one of its pages is reportable.
	const verdicts = new Map<string, { position: number; capturedHop: WebsiteNavigationHop; classification: WebsiteSiteClassification }>();
	const seenSnapshots = new Map<string, { classification: WebsiteSiteClassification; mobileHandoff: boolean }>();
	let asksForPhone = recording.agent.report?.asksForPhone === true;
	for (const [position, archive] of archives.entries()) {
		const capturedHop = capturedArchiveHop(archive);
		// Every page but the captured one is a step of the case with its own evidence
		// package; a revisit's first page is a step too.
		if (position > 0 || params.revisit) await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await websiteEvidence(submissionId, url, archive, dependencies, params.route) });
		const site = websiteSite(capturedHop.url);
		const known = verdicts.get(site);
		if (known && isReportable(known.classification)) continue;
		const snapshotKey = `${site}\n${websiteClassificationFingerprint(capturedHop, archive)}`;
		const cached = seenSnapshots.get(snapshotKey);
		if (cached) {
			asksForPhone ||= cached.mobileHandoff;
			verdicts.set(site, { position, capturedHop, classification: cached.classification });
			continue;
		}
		await emitStep(submissionId, "classification", Math.min(70, 50 + position * 4));
		const classified = await classifyCapturedPage(submissionId, capturedHop, archive, dependencies, params.instructions?.analysis);
		seenSnapshots.set(snapshotKey, classified);
		asksForPhone ||= classified.mobileHandoff;
		verdicts.set(site, { position, capturedHop, classification: classified.classification });
	}

	const chain = archives.at(-1)!.navigationHops;
	// A site this visit did not reach again keeps the earlier visit's verdict.
	const siteVerdicts = new Map<string, SiteVerdict>([...(params.revisit?.verdicts ?? []), ...[...verdicts].map(([site, { capturedHop, classification }]) => [site, { judgedHopIndex: capturedHop.index, classification }] as const)]);
	const assessments = chainSiteAssessments(chain, siteVerdicts);
	const again = (from: WebsiteNavigationHop, revisit: WebsiteRevisit): Revisit => ({ hops: chain, from, revisit, pages: shownPages, verdicts: siteVerdicts });
	const reportable = [...verdicts.values()]
		.filter(({ classification }) => isReportable(classification))
		.sort((a, b) => a.position - b.position)
		.map(({ position, capturedHop, classification }): WebsiteChainSite => ({
			archive: archives[position]!,
			capturedHop,
			classification,
			dataDrops: pages.flatMap((page) => (isSameWebsite(page.archive.url, capturedHop.url) ? page.dataSent.filter((sent) => !sent.sameSite) : [])),
		}));
	const judged = { ...base, chain, assessments, reportable, pages: shownPages };
	if (reportable.length) {
		const [headline] = reportable;
		return { ...judged, archive: headline!.archive, capturedHop: headline!.capturedHop, classification: headline!.classification };
	}

	// Nothing reportable: the last page shown is the case's.
	const archive = archives.at(-1)!;
	const capturedHop = capturedArchiveHop(archive);
	const { classification } = verdicts.get(websiteSite(capturedHop.url))!;
	// A destination that answered empty and sent the visit back turned this network away:
	// the whole flow is walked again through the others, the gate passed again in each.
	const cloak = cloakedDestination(visitNavigation(pages), url);
	if (cloak) {
		const answered = [...(params.cloaked?.answered ?? []), walked.egress ?? params.egress ?? WEBSITE_CAPTURE_EGRESS[0]!];
		const notTried = [...(params.cloaked?.notTried ?? [])];
		const startedAt = params.cloaked?.startedAt ?? flowStartedAt;
		const reopened = { ...capturedHop, url: first.url };
		// Every network the capture would try, in its order.
		for (const egress of (params.networks ?? WEBSITE_CAPTURE_EGRESS).filter((candidate) => !answered.includes(candidate) && !notTried.some(({ network }) => network === FABRIC_EGRESS_LABEL[candidate]))) {
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
				return visitWebsite({ ...params, archive: retried, egress, cloaked: { answered, notTried, startedAt }, revisit: again(reopened, { reason: "destination_cloaked", route: network, site: cloak.site }) });
			}
		}
		const cloakedRecord: WebsiteCloakedDestination = { host: cloak.host, site: cloak.site, answered: answered.map((egress) => FABRIC_EGRESS_LABEL[egress]), notTried };
		return { ...judged, archive, capturedHop, classification, cloakedDestination: cloakedRecord };
	}
	// A site that turns desktops away shows the phone something else.
	if (asksForPhone && !first.device) {
		await emitStep(submissionId, "revisit_as_phone", 72);
		// One capture browser at a time: the residential exit is a single connection.
		await session?.close();
		const phone = await capture({ url: first.url, device: "iphone", ...route });
		return visitWebsite({ ...params, archive: phone, revisit: again(capturedHop, { reason: "phone", device: "iphone" }) });
	}
	// A challenge that would not clear for this network may let the residential exit through.
	// A capture that already came from there was decoyed or turned away everywhere else.
	const challenge = recording.agent.report?.blockedByChallenge;
	let unreached: string | undefined;
	if (challenge && !params.challengeRetried && walked.egress !== CHALLENGE_RETRY_EGRESS && (params.networks ?? WEBSITE_CAPTURE_EGRESS).includes(CHALLENGE_RETRY_EGRESS)) {
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
			return visitWebsite({ ...params, archive: retried, challengeRetried: true, egress: CHALLENGE_RETRY_EGRESS, revisit: again(reopened, { reason: "challenge", route: FABRIC_EGRESS_LABEL[CHALLENGE_RETRY_EGRESS] }) });
		}
	}
	// A visit that did not get past the site's challenge saw nothing of the site behind it.
	const inconclusive = recording.agent.outcome !== "completed" ? recording.agent.failure ?? "The visiting agent did not finish the site's flow."
		: challenge ? challengeInconclusive(recording.agent.report!.stoppedReason, { retried: params.challengeRetried === true, unreached })
		: undefined;
	return { ...judged, archive, capturedHop, classification, ...(inconclusive ? { inconclusive } : {}) };
}

/** The document's own title, as a visitor reads it in the tab. */
function pageTitle(html: Buffer): string | undefined {
	return html.toString("utf-8").match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

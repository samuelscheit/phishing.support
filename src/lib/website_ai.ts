import { reporterBrowserIdentity } from "./browser/reporter_identity";
import { archiveWebsite, isBrowserInfrastructureFailure, type ArchiveWebsiteOptions, type WebsitePageSession, type WebsiteVerificationGate } from "./website_archive";
import { errorText } from "./error_text";
import { buildWebsiteEvidence, type WebsiteEvidencePackage } from "./evidence/package";
import { buildVisitEvidence } from "./evidence/visit";
import { WEBSITE_DEVICE_LABEL } from "./website_types";
import type { timestampEvidence } from "./evidence/timestamp";
import { SubmissionsEntity, ArtifactsEntity } from "./db/entities";
import type { WebsiteSubmissionData } from "./db/schema";
import { getInfo } from "./website_info";
import { runStreamedAnalysisRun, type AnalysisClient } from "./analysis_run";
import { publishEvent } from "./event/event_transport";
import { reportConfirmedWebsiteAbuse } from "./abuse/submission_reports";
import { AbuseSkyvernAdapter } from "./abuse/skyvern";
import { createWebsiteSubmission } from "./submissions/website";
import type { ReporterMetadata } from "./request_metadata";
import { defaultReasoning, defaultResponseModel, sleep } from "./utils";
import { offeredDownloadOf, offeredDownloadSource } from "./website_offered_download";
import type { LookupResult } from "./exfiltration/downloads/policy";
import { analyzedCaptureStep, latestArtifactNamed, websiteCaptureFileNames } from "./website_capture_files";
import { extractPasteCommands } from "./malware/paste_commands";
import { isSameWebsite, websiteSite } from "./website_site";
import { createExfiltrationCanaries } from "./exfiltration/canaries";
import { discoverExfiltrationBackends } from "./exfiltration/analysis";
import type { CapturedNetworkRequest, ExfiltrationBackend, ExfiltrationCanaries } from "./exfiltration/types";
import { skyvernVisitAgent, type VisitAgent } from "./site_visit/agent";
import { visitNavigation, visitPages, type VisitPage } from "./site_visit/evidence";
import type { SiteVisitRecording } from "./site_visit/visit";
import { buildWebsiteAnalysisInput, type NarrativeVisitPage } from "./website_narrative";
import {
	buildWebsiteClassificationInput,
	buildWebsiteReportEvidence,
	classifiedHiddenFrame,
	normalizedEvidence,
	QUOTE_GAP,
	validateWebsiteSiteClassification,
	verbatimEvidenceQuote,
	websiteMobileHandoff,
	WEBSITE_CLASSIFICATION_FORMAT,
	type WebsiteEvidenceArchive,
} from "./website_classification";
import type {
	ReportableWebsiteFinding,
	VisitDataSent,
	WebsiteCloaking,
	WebsiteDevice,
	WebsiteHiddenFrame,
	WebsiteKitResource,
	WebsiteNavigationHop,
	WebsiteOfferedDownload,
	WebsiteSiteAssessment,
	WebsiteSiteClassification,
	WebsiteVisitRecord,
} from "./website_types";

export async function emitStep(streamId: bigint | string | undefined, step: string, progress: number) {
	if (!streamId) return;
	await publishEvent(`run:${streamId}`, { type: "analysis.step", step, progress });
}

type WebsiteCapture = Awaited<ReturnType<typeof archiveWebsite>> & { offeredDownload?: WebsiteOfferedDownload; dataSent?: VisitDataSent[] };

export function websiteSiteAssessments(
	hops: WebsiteNavigationHop[],
	capturedHopIndex: number,
	capturedClassification: WebsiteSiteClassification,
): WebsiteSiteAssessment[] {
	const capturedHop = hops.find((hop) => hop.index === capturedHopIndex && hop.contentCaptured);
	return hops.map((hop) => ({
		hopIndex: hop.index,
		// A redirect within the captured site is part of it. A redirect response
		// on another site has no captured page of its own and cannot inherit the
		// destination's classification or trigger a report.
		...(capturedHop && isSameWebsite(hop.url, capturedHop.url)
			? capturedClassification
			: { finding: "insufficient_evidence" as const }),
	}));
}

/**
 * Every URL of the captured site in the navigation, captured page first:
 * single-URL providers receive the page itself, while URL lists also cover
 * the same-site link a visitor actually received.
 */
export function websiteReportUrls(hops: WebsiteNavigationHop[], capturedHop: WebsiteNavigationHop): string[] {
	return [...new Set([capturedHop.url, ...hops.filter((hop) => isSameWebsite(hop.url, capturedHop.url)).map((hop) => hop.url)])];
}

/**
 * The navigation as if the captured site had been submitted directly: the
 * trailing run of hops on that site, ending at the captured page.
 */
export function capturedHostNavigation(hops: WebsiteNavigationHop[], capturedHop: WebsiteNavigationHop): WebsiteNavigationHop[] {
	const end = hops.findIndex((hop) => hop.index === capturedHop.index);
	let start = end;
	while (start > 0 && isSameWebsite(hops[start - 1]!.url, capturedHop.url)) start--;
	return hops.slice(start, end + 1).map((hop, index) => ({ ...hop, index }));
}


/** The reported finding of a corroborated classification. */
function reportableFinding(classification: WebsiteSiteClassification): ReportableWebsiteFinding {
	if (classification.finding === "malware") return { finding: "malware" };
	if (classification.finding === "phishing" && classification.phishingBasis) return { finding: "phishing", phishingBasis: classification.phishingBasis };
	throw new Error("A reportable classification is missing its finding or phishing basis.");
}

export function reportableWebsiteHop(
	hops: WebsiteNavigationHop[],
	assessments: WebsiteSiteAssessment[],
	archive: Pick<WebsiteEvidenceArchive, "url" | "text" | "hiddenFrames" | "offeredDownload">,
): WebsiteNavigationHop | undefined {
	const capturedHop = hops.find((hop) => hop.contentCaptured && hop.url === archive.url);
	if (!capturedHop) return undefined;
	const assessment = assessments.find((candidate) => candidate.hopIndex === capturedHop.index);
	if ((assessment?.finding !== "phishing" && assessment?.finding !== "malware") || !assessment.evidenceQuote) return undefined;
	const download = assessment.offeredDownload && archive.offeredDownload?.sha256 === assessment.offeredDownload.sha256 ? archive.offeredDownload : undefined;
	const source = assessment.hiddenFrame
		? archive.hiddenFrames?.find((frame) => frame.ref === assessment.hiddenFrame!.ref && frame.url === assessment.hiddenFrame!.url)?.source
		: assessment.offeredDownload
			? download && offeredDownloadSource(download)
			: archive.text.toString("utf-8");
	if (source === undefined) return undefined;
	const stored = assessment.evidenceQuote.split(QUOTE_GAP).join("\n");
	return typeof verbatimEvidenceQuote(stored, normalizedEvidence(source)) === "string"
		? capturedHop
		: undefined;
}

function capturedArchiveHop(archive: Pick<WebsiteEvidenceArchive, "url" | "navigationHops">): WebsiteNavigationHop {
	const capturedHops = archive.navigationHops.filter((hop) => hop.contentCaptured && hop.url === archive.url);
	if (capturedHops.length !== 1) throw new Error("Website archive must bind its content to exactly one navigation hop.");
	return capturedHops[0]!;
}

/** What a capture contributes to the submission record. */
function capturedWebsiteData(archive: WebsiteCapture) {
	return {
		archiveUrl: archive.url,
		navigationHops: archive.navigationHops,
		...(archive.cloaking ? { cloaking: archive.cloaking } : {}),
		...(archive.verificationGate ? { verificationGate: archive.verificationGate } : {}),
		...(archive.providerWarning ? { providerWarning: archive.providerWarning } : {}),
		...(archive.kitResources?.length ? { kitResources: archive.kitResources } : {}),
		...(archive.hiddenFrames?.length ? { hiddenFrames: archive.hiddenFrames } : {}),
		...(archive.offeredDownload ? { offeredDownload: archive.offeredDownload } : {}),
		...(archive.device ? { device: archive.device } : {}),
	};
}

/** The evidence package for a capture: stamped screenshot, manifest, and its timestamp. */
async function websiteEvidence(
	submissionId: bigint,
	submittedUrl: string,
	archive: WebsiteCapture,
	dependencies: WebsiteAnalysisDependencies,
): Promise<WebsiteEvidencePackage> {
	return buildWebsiteEvidence({
		caseId: submissionId.toString(),
		step: analyzedCaptureStep(archive.navigationHops),
		submittedUrl,
		capturedUrl: archive.url,
		capturedAt: archive.archivedAt,
		...(archive.route ? { route: archive.route } : {}),
		navigationHops: archive.navigationHops,
		...(archive.screenshotPng ? { screenshotPng: archive.screenshotPng } : {}),
		mhtml: archive.mhtml,
	}, dependencies.timestampEvidence ? { timestamp: dependencies.timestampEvidence } : {});
}

/**
 * Keep the visit as timestamped evidence next to the case's captures: the
 * synthetic values, what the agent typed where, the pages shown, and every
 * request that carried a value with the server's answer.
 */
async function saveVisitEvidence(params: {
	submissionId: bigint;
	url: string;
	device?: WebsiteDevice;
	recording: SiteVisitRecording<WebsiteCapture>;
	pages: ReadonlyArray<VisitPage<WebsiteCapture>>;
	canaries: ExfiltrationCanaries;
	dependencies: WebsiteAnalysisDependencies;
}): Promise<void> {
	const { recording } = params;
	const endedAt = new Date();
	const evidence = await buildVisitEvidence({
		caseId: params.submissionId.toString(),
		submittedUrl: params.url,
		startedAt: recording.startedAt,
		endedAt,
		environment: {
			device: WEBSITE_DEVICE_LABEL[params.device ?? "desktop"],
			...(process.env.FABRIC_PHISHING_EGRESS_POLICY_REF ? { egress: `Browser Fabric egress policy ${process.env.FABRIC_PHISHING_EGRESS_POLICY_REF}` } : {}),
			agent: "Skyvern",
			...(recording.agent.runId ? { agentRunId: recording.agent.runId } : {}),
			agentOutcome: recording.agent.outcome,
		},
		syntheticValues: params.canaries,
		actions: recording.agent.actions,
		pages: params.pages.map((page) => ({ url: page.archive.url, shownFrom: page.shownFrom, ...(page.shownUntil ? { shownUntil: page.shownUntil } : {}) })),
		requests: recording.requests,
		backends: discoverExfiltrationBackends({ requests: recording.requests, canaries: params.canaries, pageUrl: params.url }),
	}, params.dependencies.timestampEvidence ? { timestamp: params.dependencies.timestampEvidence } : {});
	for (const file of evidence.files) {
		await ArtifactsEntity.saveBuffer({ submissionId: params.submissionId, name: file.name, kind: "website_evidence", mimeType: file.mimeType, archivedAt: endedAt, buffer: file.bytes });
	}
}

/** Every page's kit files, once per hash. */
function mergedKitResources(...captures: WebsiteCapture[]): WebsiteKitResource[] {
	return captures.flatMap((capture) => capture.kitResources ?? [])
		.filter((resource, index, all) => all.findIndex((other) => other.sha256 === resource.sha256) === index);
}


async function classifyCapturedPage(submissionId: bigint, hop: WebsiteNavigationHop, archive: WebsiteEvidenceArchive, dependencies: WebsiteAnalysisDependencies) {
	const { result } = await runStreamedAnalysisRun({
		submissionId,
		analysisKind: "classification",
		options: {
			model: defaultResponseModel,
			input: buildWebsiteClassificationInput(hop, archive),
			text: { format: WEBSITE_CLASSIFICATION_FORMAT, verbosity: "low" },
			stream: true,
		},
	}, { client: dependencies.analysisClient });
	return {
		classification: validateWebsiteSiteClassification(result.output_parsed, archive.text.toString("utf-8"), archive.html.toString("utf-8"), archive.hiddenFrames, archive.offeredDownload, hop.url),
		mobileHandoff: websiteMobileHandoff(result.output_parsed),
	};
}

const isReportable = (classification: WebsiteSiteClassification) => classification.finding === "phishing" || classification.finding === "malware";

/** The visit as the case keeps it: what the agent did and every request that carried synthetic values. */
function visitRecord(recording: SiteVisitRecording<unknown>, pages: ReadonlyArray<VisitPage<unknown>>): WebsiteVisitRecord {
	const { agent } = recording;
	return {
		...(agent.runId ? { runId: agent.runId } : {}),
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
type WebsiteVisitResult = {
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
async function visitWebsite(params: {
	submissionId: bigint;
	url: string;
	whois: Awaited<ReturnType<typeof getInfo>>;
	archive: WebsiteCapture;
	dependencies: WebsiteAnalysisDependencies;
	capture: (options: ArchiveWebsiteOptions) => Promise<WebsiteCapture>;
	/** The phone revisit that led to this capture, when it is one. */
	revisit?: { hops: WebsiteNavigationHop[]; from: WebsiteNavigationHop };
}): Promise<WebsiteVisitResult> {
	const { submissionId, url, whois, dependencies, capture } = params;
	const first = params.archive;
	const device = first.device ? { device: first.device } : {};
	await emitStep(submissionId, "site_visit", 45);
	// A page from a stored capture is loaded live first: the visit walks the live site.
	const session = first.session ?? (await capture({ url: first.url, ...device })).session;
	const canaries = createExfiltrationCanaries();
	const agent = dependencies.visitAgent ?? skyvernVisitAgent(() => new AbuseSkyvernAdapter());
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
			// A site that turns desktops away shows the phone something else.
			if (!isReportable(classified.classification) && asksForPhone && !first.device) {
				await emitStep(submissionId, "revisit_as_phone", 72);
				const phone = await capture({ url: first.url, device: "iphone" });
				return visitWebsite({ ...params, archive: phone, revisit: { hops: archive.navigationHops, from: capturedHop } });
			}
			const inconclusive = !isReportable(classified.classification) && recording.agent.outcome !== "completed"
				? recording.agent.failure ?? "The visiting agent did not finish the site's flow."
				: undefined;
			return { ...base, archive, capturedHop, classification: classified.classification, assessments, pages: narrativePages(position), ...(inconclusive ? { inconclusive } : {}) };
		}
	}
	throw new Error("A visit always has the captured page.");
}

/** The document's own title, as a visitor reads it in the tab. */
function pageTitle(html: Buffer): string | undefined {
	return html.toString("utf-8").match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || undefined;
}

/** The desktop navigation, its last page marked as opened again on a phone, before the phone's own hops. */
function continuedRevisit(revisit: { hops: WebsiteNavigationHop[]; from: WebsiteNavigationHop }): WebsiteNavigationHop[] {
	return revisit.hops.map((hop) => (hop.index === revisit.from.index ? { ...hop, contentCaptured: false, redirectTo: hop.url, revisitedAs: "iphone" as const } : hop));
}

/**
 * The captured pages' screenshots for providers, stamped with their URL and
 * capture time where that worked: the analyzed page first, then the pages of
 * its flow that led to it.
 */
async function capturedPageScreenshots(submissionId: bigint, analyzedStep: number): Promise<Array<{ filename: string; png: Buffer }>> {
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const screenshots: Array<{ filename: string; png: Buffer }> = [];
	for (const step of [analyzedStep, ...Array.from({ length: analyzedStep }, (_, index) => index)]) {
		const names = websiteCaptureFileNames(step);
		const stored = latestArtifactNamed(artifacts, names.stampedScreenshot) ?? latestArtifactNamed(artifacts, names.screenshot);
		const png = stored ? (await ArtifactsEntity.get(stored.id))?.blob : undefined;
		if (png?.byteLength) screenshots.push({ filename: names.screenshot, png: Buffer.from(png) });
	}
	return screenshots;
}

export type AnalyzeWebsiteOptions = {
	mhtmlSnapshot?: Buffer;
	/** Original captured document URL for retained MHTML, distinct from its submitted URL. */
	archivedUrl?: string;
	/** Original response-by-response provenance for retained MHTML. */
	navigationHops?: WebsiteNavigationHop[];
	/** Set only when MHTML was loaded from this submission's internally archived artifact. */
	trustMhtmlDocumentLocation?: boolean;
	/** Existing evidence screenshot used when a retry parses MHTML locally. */
	screenshotSnapshot?: Buffer;
	/** The network route the original live capture of retained MHTML used. */
	captureRoute?: string;
	/** The verification gate retained MHTML was captured behind. */
	verificationGate?: WebsiteVerificationGate;
	/** Same-host scripts and stylesheets the original live capture of retained MHTML received. */
	kitResources?: WebsiteKitResource[];
	/** Hidden frames the original live capture of retained MHTML recorded. */
	hiddenFrames?: WebsiteHiddenFrame[];
	/** The phone the original live capture of retained MHTML presented. */
	device?: WebsiteDevice;
	/** Reuse the existing website archive artifacts instead of writing duplicates. */
	reuseEvidenceArtifacts?: boolean;
	url: string;
	submissionId: bigint;
} & ReporterMetadata;

/** Network boundaries of one website analysis; tests replace them. */
export type WebsiteAnalysisDependencies = {
	getInfo?: typeof getInfo;
	archiveWebsite?: typeof archiveWebsite;
	analysisClient?: AnalysisClient;
	/** Waits between capture attempts after a browser-service failure. */
	browserBackoffMs?: readonly number[];
	/** The RFC 3161 authority call that timestamps the evidence manifest. */
	timestampEvidence?: typeof timestampEvidence;
	/** What malware scanners say about an offered file's hash. */
	downloadLookups?: (sha256: string) => Promise<LookupResult[]>;
	/** The agent that walks the site; Skyvern in production. */
	visitAgent?: VisitAgent;
};

/** Capture retries after a browser-service failure: 5 s, 15 s, then 45 s. */
const BROWSER_BACKOFF_MS = [5_000, 15_000, 45_000] as const;

/**
 * Retry a capture only when the browser service failed (relay full, a dropped
 * CDP connection, a closed target). A site that blocks or times out was
 * already retried across every egress inside the capture and is final.
 */
async function withBrowserBackoff<T>(capture: () => Promise<T>, delaysMs: readonly number[]): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await capture();
		} catch (error) {
			const delayMs = delaysMs[attempt];
			if (delayMs === undefined || !isBrowserInfrastructureFailure(error)) throw error;
			console.warn(`Website capture hit a browser-service failure (${errorText(error)}); retrying in ${delayMs / 1000}s.`);
			await sleep(delayMs);
		}
	}
}

/**
 * A capture that ended on another site belongs to that site: it opens that
 * site's own case with the captured evidence and its same-site navigation, as
 * if the destination had been submitted directly. The submitted site gets no
 * finding of its own; its navigation links to the destination case. `via`
 * names the step of the submitted site's flow that led there (its button, its
 * link, its field), when the capture had to take one.
 */
async function handOffRedirectedCapture(params: {
	submissionId: bigint;
	url: string;
	whois: Awaited<ReturnType<typeof getInfo>>;
	archive: WebsiteCapture;
	capturedHop: WebsiteNavigationHop;
	reporter: ReporterMetadata;
	dependencies: WebsiteAnalysisDependencies;
	via?: string;
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
	}, (options) => analyzeWebsite(options, params.dependencies));
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

function cloakingSuspectedInfo(cloaking: WebsiteCloaking): string {
	return `Cloaking suspected: ${cloaking.detail}. No verdict or report was made from the decoy; retry to visit the site again.`;
}

/** Settle the submitted cases that were handed off to this destination and wait on its verdict. */
async function settleCloakedRedirectsTo(destinationId: bigint): Promise<void> {
	for (const submission of await SubmissionsEntity.listRedirectedTo(destinationId)) {
		await settleCloakedRedirect(submission.id);
	}
}

export async function analyzeWebsite(options: AnalyzeWebsiteOptions, dependencies: WebsiteAnalysisDependencies = {}): Promise<bigint> {
	const { url, submissionId, reporterIp, reporterCountry, reporterHeaders, reuseEvidenceArtifacts = false } = options;
	// Every live capture keeps its browser open for the flow's next action on
	// the page; each one is closed once the flow is done with it.
	const sessions: WebsitePageSession[] = [];
	// Automatic retries already spent on this case; the run's own data writes drop the record.
	let priorAttempts = 0;
	const closeSessions = () => Promise.all(sessions.splice(0).map((session) => session.close().catch((error: unknown) => console.warn("Closing a capture browser failed:", error))));
	// Every live capture of the case, the visit's included, presents the reporter's own browser.
	const visitor = reporterBrowserIdentity(reporterHeaders);
	const capture = async (captureOptions: ArchiveWebsiteOptions) => {
		const captured = await withBrowserBackoff(() => (dependencies.archiveWebsite ?? archiveWebsite)({ ...captureOptions, ...(visitor ? { visitor } : {}), keepSession: true }), dependencies.browserBackoffMs ?? BROWSER_BACKOFF_MS);
		if (captured.session) sessions.push(captured.session);
		return captured;
	};
	try {
		const prior = await SubmissionsEntity.get(submissionId);
		priorAttempts = (prior?.data.kind === "website" && prior.data.website.autoRetry?.attempts) || 0;
		// Claim the submission before any network work. Previously the first
		// unbounded WHOIS lookup ran while the row still said `new`, so a process
		// restart could leave it looking queued forever with no retry path.
		await SubmissionsEntity.update(submissionId, { status: "running", info: "Collecting bounded WHOIS, RDAP, and regional DNS evidence." });
		await emitStep(submissionId, "whois_lookup", 5);
		const whois = await (dependencies.getInfo ?? getInfo)(url);

		await SubmissionsEntity.update(submissionId, {
			status: "running",
			info: undefined,
			data: { kind: "website", website: { url, whois } },
		});

		await emitStep(submissionId, "archive_website", 10);
		const captured = await capture({
			url,
			mhtmlSnapshot: options.mhtmlSnapshot,
			archivedUrl: options.archivedUrl,
			navigationHops: options.navigationHops,
			trustMhtmlDocumentLocation: options.trustMhtmlDocumentLocation,
			verificationGate: options.verificationGate,
			kitResources: options.kitResources,
			hiddenFrames: options.hiddenFrames,
			device: options.device,
		});
		let archive: WebsiteCapture = {
			...captured,
			...(!captured.screenshotPng && options.screenshotSnapshot ? { screenshotPng: options.screenshotSnapshot } : {}),
			...(!captured.route && options.captureRoute ? { route: options.captureRoute } : {}),
		};
		if (archive.cloaking?.outcome === "unresolved") {
			// The capture holds only the decoy every reachable route was shown. It
			// is neither evidence against the submitted site nor a case of its own.
			await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await websiteEvidence(submissionId, url, archive, dependencies) });
			await SubmissionsEntity.update(submissionId, {
				status: "failed",
				info: cloakingSuspectedInfo(archive.cloaking),
				data: { kind: "website", website: { url, whois, archiveUrl: archive.url, navigationHops: archive.navigationHops, cloaking: archive.cloaking } },
			});
			await emitStep(submissionId, "failed", 100);
			return submissionId;
		}
		let capturedHop = archive.attributionError ? undefined : capturedArchiveHop(archive);
		if (capturedHop && !isSameWebsite(capturedHop.url, url)) {
			await handOffRedirectedCapture({ submissionId, url, whois, archive, capturedHop, reporter: { reporterIp, reporterCountry, reporterHeaders }, dependencies });
			await emitStep(submissionId, "completed", 100);
			return submissionId;
		}

		await emitStep(submissionId, "save_artifacts", 40);
		// A retry that reuses the stored capture keeps its original evidence package.
		if (!reuseEvidenceArtifacts) {
			await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await websiteEvidence(submissionId, url, archive, dependencies) });
		}
		if (!capturedHop) {
			await SubmissionsEntity.update(submissionId, {
				status: "invalid",
				info: `${archive.attributionError} No report was created; resubmit the exact site whose page should be analyzed.`,
			});
			await emitStep(submissionId, "completed", 100);
			return submissionId;
		}
		await SubmissionsEntity.update(submissionId, {
			data: {
				kind: "website",
				website: { url, whois, ...capturedWebsiteData(archive) },
			},
		});

		const visited = await visitWebsite({ submissionId, url, whois, archive, dependencies, capture }).finally(closeSessions);
		archive = visited.archive;
		capturedHop = visited.capturedHop;
		const { classification: capturedClassification, record: visit } = visited;
		if (visited.handedOff) {
			await handOffRedirectedCapture({ submissionId, url, whois, archive, capturedHop, via: "its own flow", reporter: { reporterIp, reporterCountry, reporterHeaders }, dependencies });
			await emitStep(submissionId, "completed", 100);
			return submissionId;
		}

		await emitStep(submissionId, "analysis_run", 75);
		await runStreamedAnalysisRun({
			submissionId,
			analysisKind: "analysis",
			options: {
				model: defaultResponseModel,
				input: buildWebsiteAnalysisInput(archive, { whois, pages: visited.pages, visit, kitResources: archive.kitResources, capturedAt: archive.archivedAt }),
				reasoning: defaultReasoning,
				tools: [{ type: "web_search" }],
				stream: true,
			},
		}, { client: dependencies.analysisClient });

		const siteAssessments = visited.assessments;
		await SubmissionsEntity.update(submissionId, {
			data: {
				kind: "website",
				website: { url, whois, ...capturedWebsiteData(archive), siteAssessments, visit },
			},
		});

		const reportableSite = reportableWebsiteHop(archive.navigationHops, siteAssessments, archive);
		if (reportableSite) {
			const finding = reportableFinding(capturedClassification);
			const label = finding.finding === "malware" ? "Malware distribution" : "Phishing";
			await emitStep(submissionId, "reporting", 90);
			const reportUrls = websiteReportUrls(archive.navigationHops, reportableSite);
			const commands = extractPasteCommands(archive.text.toString("utf-8"));
			await reportConfirmedWebsiteAbuse({
				submissionId,
				urls: reportUrls,
				analysisText: buildWebsiteReportEvidence(capturedClassification, { commands, navigationHops: archive.navigationHops, hiddenFrames: archive.hiddenFrames, device: archive.device, ...(visitor ? { reporterUserAgent: visitor.override.userAgent } : {}), providerWarning: archive.providerWarning, offeredDownload: archive.offeredDownload, dataDrops: visited.dataDrops }),
				...(archive.userAgent ? { userAgent: archive.userAgent } : {}),
				screenshots: await capturedPageScreenshots(submissionId, analyzedCaptureStep(archive.navigationHops)),
				reporter: { reporterIp, reporterCountry, reporterHeaders },
				finding,
				pasteCommands: commands,
				...(finding.finding === "malware" && archive.offeredDownload ? { offeredDownload: archive.offeredDownload } : {}),
				...(capturedClassification.impersonatedBrand ? { legalBrandUrl: capturedClassification.impersonatedBrand.officialUrl } : {}),
				...(capturedClassification.hiddenFrame ? { hiddenFrame: classifiedHiddenFrame(capturedClassification, archive.hiddenFrames)! } : {}),
				...(visited.backends.length ? { visitCapture: { canaries: visited.canaries, requests: visited.requests, backends: visited.backends } } : {}),
			});

			await SubmissionsEntity.update(submissionId, {
				status: "reported",
				info: reportUrls.length === 1
					? `${label} confirmed at ${reportableSite.url}; its evidence is being collected before the report is sent.`
					: `${label} confirmed at ${reportableSite.url}; evidence for it and the ${reportUrls.length - 1} URL${reportUrls.length === 2 ? "" : "s"} on ${websiteSite(reportableSite.url)} that lead${reportUrls.length === 2 ? "s" : ""} to it is being collected before the report is sent.`,
			});
		} else if (visited.inconclusive) {
			// The visit did not finish, so the last page it reached is no verdict on the site.
			await failWebsiteAnalysis(submissionId, {
				info: `Inconclusive: the visit could not finish the site's flow: ${visited.inconclusive} The last page it reached, ${archive.url}, shows nothing reportable by itself; no verdict or report was made.`,
				data: { unfinishedFlow: visited.inconclusive },
				retry: { attempts: priorAttempts, reason: visited.inconclusive, exhausted: (visits: number) => `The visit stopped there ${visits} times; retry to visit the site again.` },
			});
			await emitStep(submissionId, "failed", 100);
			return submissionId;
		} else {
			const { finding, rejectedClaim } = capturedClassification;
			const verdict = finding === "prank_or_troll"
				? `The captured destination ${archive.url} was classified as a prank or troll page, not phishing or malware; no report was created.`
				: rejectedClaim
					? `The classifier's finding for ${archive.url} was not corroborated by the captured page: ${rejectedClaim}. No report was created.`
					: `No reportable phishing or malware evidence was found at the captured destination ${archive.url}; no report was created.`;
			await SubmissionsEntity.update(submissionId, { status: "invalid", info: verdict });
		}

		await emitStep(submissionId, "completed", 100);
	} catch (error) {
		console.error("Website analysis failed:", error);
		await recordWebsiteAnalysisFailure(submissionId, error, priorAttempts);
		await emitStep(submissionId, "failed", 100);
	} finally {
		await closeSessions();
		await settleCloakedRedirectsTo(submissionId).catch((error: unknown) => console.error("Settling redirected cases failed:", error));
	}

	return submissionId;
}

/** Automatic re-queues of a failure another visit can change: 10 minutes apart, at most 3 times. */
const AUTO_RETRY_DELAY_MS = 10 * 60_000;
const MAX_AUTO_RETRIES = 3;

/**
 * Fail the case with a readable reason. A failure another visit can change
 * (`retry`: the browser service failed, or the site's flow could not be
 * finished) is re-queued automatically instead of waiting until someone
 * notices; `exhausted` says so once the retries are spent.
 */
async function failWebsiteAnalysis(submissionId: bigint, failure: {
	info: string;
	data?: Partial<WebsiteSubmissionData>;
	retry?: { attempts: number; reason: string; exhausted: (visits: number) => string };
}): Promise<void> {
	const submission = await SubmissionsEntity.get(submissionId);
	const current = submission?.data.kind === "website" ? submission.data.website : undefined;
	const website = current && { ...current, ...failure.data, autoRetry: undefined };
	const { retry } = failure;
	if (!website || !retry || retry.attempts >= MAX_AUTO_RETRIES) {
		await SubmissionsEntity.update(submissionId, {
			status: "failed",
			info: website && retry ? `${failure.info} ${retry.exhausted(retry.attempts + 1)}` : failure.info,
			...(website ? { data: { kind: "website" as const, website } } : {}),
		});
		return;
	}
	const nextAttemptAt = new Date(Date.now() + AUTO_RETRY_DELAY_MS);
	await SubmissionsEntity.update(submissionId, {
		status: "failed",
		info: `${failure.info} Retrying automatically at ${nextAttemptAt.toISOString().slice(11, 16)} UTC (attempt ${retry.attempts + 1} of ${MAX_AUTO_RETRIES}).`,
		data: { kind: "website", website: { ...website, autoRetry: { attempts: retry.attempts + 1, nextAttemptAt: nextAttemptAt.toISOString(), reason: retry.reason } } },
	});
}

/** A failed run: retried automatically when the browser service (not the site) failed. */
async function recordWebsiteAnalysisFailure(submissionId: bigint, error: unknown, attempts: number): Promise<void> {
	const reason = errorText(error);
	await failWebsiteAnalysis(submissionId, isBrowserInfrastructureFailure(error)
		? { info: `The browser service failed (${reason}).`, retry: { attempts, reason, exhausted: (visits) => `It failed ${visits} times in a row; retry once it has recovered.` } }
		: { info: reason });
}

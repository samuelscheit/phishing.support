import { reporterBrowserIdentity } from "../../browser/reporter_identity";
import { archiveWebsite } from "../archive";
import type { ArchiveWebsiteOptions, WebsitePageSession, WebsiteVerificationGate } from "../archive/types";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import { getInfo } from "../info/info";
import { runStreamedAnalysisRun } from "../../analysis/run";
import { reportConfirmedWebsiteAbuse } from "../../abuse/submission_reports";
import type { CreatedAbuseReport } from "../../abuse/repository";
import type { ReporterMetadata } from "../../http/reporter_headers";
import { defaultReasoning, defaultResponseModel } from "../../openai/client";
import { analyzedCaptureStep } from "../visit/capture_files";
import { extractPasteCommands } from "../../malware/paste_commands";
import { websiteSite } from "../info/site";
import { accessGateOf, checkBareVisit, type BareVisitDependencies } from "../visit/access_gate";
import { abuseEmailCaseUrl } from "../../abuse/mail/draft";
import { buildWebsiteAnalysisInput } from "./narrative";
import { buildWebsiteReportEvidence, classifiedHiddenFrame } from "./classification";
import type { ReportableWebsiteFinding, WebsiteDevice, WebsiteHiddenFrame, WebsiteKitResource, WebsiteNavigationHop } from "../types";
import { emitStep } from "../visit/progress";
import { capturedArchiveHop, reportableFinding, reportableWebsiteHop, unreportedVerdict, websiteReportUrls } from "../info/report_hops";
import { capturedPageScreenshots, capturedWebsiteData, websiteEvidence } from "./evidence";
import { visitWebsite, type WebsiteChainSite } from "../visit/visit";
import { cloakedDestinationInfo, cloakingSuspectedInfo, harmlessScriptedDestination } from "../archive/cloaking";
import { BROWSER_BACKOFF_MS, failWebsiteAnalysis, recordWebsiteAnalysisFailure, withBrowserBackoff } from "./failure";
import type { WebsiteAnalysisDependencies, WebsiteCapture } from "./analysis_types";

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
		// Claim the submission before any network work: while the row still says
		// `new`, a restart during the first lookup would leave it looking queued
		// forever with no retry path.
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
			// is no evidence against any site of the chain.
			await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await websiteEvidence(submissionId, url, archive, dependencies) });
			await SubmissionsEntity.update(submissionId, {
				status: "failed",
				info: cloakingSuspectedInfo(archive.cloaking),
				data: { kind: "website", website: { url, whois, archiveUrl: archive.url, navigationHops: archive.navigationHops, cloaking: archive.cloaking } },
			});
			await emitStep(submissionId, "failed", 100);
			return submissionId;
		}
		const capturedHop = archive.attributionError ? undefined : capturedArchiveHop(archive);

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
				website: { url, whois, ...capturedWebsiteData(archive), analyzedHopIndex: capturedHop.index },
			},
		});

		const visited = await visitWebsite({ submissionId, url, whois, archive, dependencies, capture }).finally(closeSessions);
		archive = visited.archive;
		const { chain, record: visit } = visited;
		// Decided once, before the narrative: it explains these findings and never judges a site again.
		const siteAssessments = visited.assessments;
		const confirmed = visited.reportable.flatMap((site) => {
			const hop = reportableWebsiteHop(site.archive.navigationHops, siteAssessments, site.archive);
			return hop ? [{ ...site, capturedHop: hop, capture: findingCapture(site) }] : [];
		});
		const headline = confirmed[0] ?? { archive, capturedHop: visited.capturedHop, classification: visited.classification };
		// A scripted jump of the residential exit to a chain that shows nothing reportable led to a decoy.
		// A destination that turned every network away is said as such, not as a decoy.
		const decoy = !confirmed.length && !visited.inconclusive && !visited.cloakedDestination && archive.cloaking?.outcome === "scripted" ? harmlessScriptedDestination(archive.cloaking) : undefined;
		const inconclusive = confirmed.length ? undefined : visited.inconclusive
			&& `Inconclusive: the visit could not finish the site's flow: ${visited.inconclusive} The last page it reached, ${archive.url}, shows nothing reportable by itself; no verdict or report was made.`;
		const caseFinding = confirmed.length
			? `${confirmed.map((site) => buildWebsiteReportEvidence(site.classification, site.capture)).join("\n\n")}\n${confirmed.length === 1 ? "The site is reported to the responsible providers." : "Each of these sites is reported to its responsible providers."}`
			: decoy ? cloakingSuspectedInfo(decoy)
			: visited.cloakedDestination ? cloakedDestinationInfo(visited.cloakedDestination)
			: inconclusive ?? unreportedVerdict(visited.classification, archive.url);

		await emitStep(submissionId, "analysis_run", 75);
		await runStreamedAnalysisRun({
			submissionId,
			analysisKind: "analysis",
			options: {
				model: defaultResponseModel,
				input: buildWebsiteAnalysisInput(headline.archive, { finding: caseFinding, whois, pages: visited.pages, visit, kitResources: headline.archive.kitResources, capturedAt: headline.archive.archivedAt }),
				reasoning: defaultReasoning,
				tools: [{ type: "web_search" }],
				stream: true,
			},
		}, { client: dependencies.analysisClient });

		await SubmissionsEntity.update(submissionId, {
			data: {
				kind: "website",
				website: {
					url,
					whois,
					...capturedWebsiteData(headline.archive),
					navigationHops: chain,
					analyzedHopIndex: headline.capturedHop.index,
					siteAssessments,
					visit,
					...(decoy ? { cloaking: decoy } : {}),
					...(visited.cloakedDestination ? { cloakedDestination: visited.cloakedDestination } : {}),
				},
			},
		});

		if (confirmed.length) {
			await emitStep(submissionId, "reporting", 90);
			const outcomes: string[] = [];
			// The visit's traffic goes with the first report this case files itself, whose investigation reports each data drop once;
			// a site another case already reports keeps its report as it is.
			let trafficFiled = !visited.backends.length;
			for (const [position, site] of confirmed.entries()) {
				const finding = reportableFinding(site.classification);
				const reportUrls = websiteReportUrls(chain, site.capturedHop);
				const accessGate = await reportAccessGate(chain, site.capturedHop.url, site.archive.userAgent, dependencies.bareVisit);
				// Kept with the case for answers to providers: the gate of the page its verdict rests on.
				if (accessGate && position === 0) await SubmissionsEntity.setWebsiteField(submissionId, "accessGate", accessGate);
				const created = await reportConfirmedWebsiteAbuse({
					submissionId,
					urls: reportUrls,
					analysisText: buildWebsiteReportEvidence(site.classification, { ...site.capture, ...(visitor ? { reporterUserAgent: visitor.override.userAgent } : {}), accessGate, caseUrl: abuseEmailCaseUrl(submissionId) }),
					...(site.archive.userAgent ? { userAgent: site.archive.userAgent } : {}),
					screenshots: await capturedPageScreenshots(submissionId, analyzedCaptureStep(site.archive.navigationHops)),
					reporter: { reporterIp, reporterCountry, reporterHeaders },
					finding,
					pasteCommands: site.capture.commands,
					...(finding.finding === "malware" && site.archive.offeredDownload ? { offeredDownload: site.archive.offeredDownload } : {}),
					...(site.classification.impersonatedBrand ? { legalBrandUrl: site.classification.impersonatedBrand.officialUrl } : {}),
					...(site.classification.hiddenFrame ? { hiddenFrame: classifiedHiddenFrame(site.classification, site.archive.hiddenFrames)! } : {}),
					...(trafficFiled ? {} : { visitCapture: { canaries: visited.canaries, requests: visited.requests, backends: visited.backends } }),
				});
				trafficFiled ||= created.created;
				outcomes.push(reportOutcome(finding, site.capturedHop.url, reportUrls, created));
			}
			await SubmissionsEntity.update(submissionId, { status: "reported", info: outcomes.join("\n") });
		} else if (visited.inconclusive && inconclusive) {
			// The visit did not finish, so the last page it reached is no verdict on the site.
			await failWebsiteAnalysis(submissionId, {
				info: inconclusive,
				data: { unfinishedFlow: visited.inconclusive },
				retry: { attempts: priorAttempts, reason: visited.inconclusive, exhausted: (visits: number) => `The visit stopped there ${visits} times; retry to visit the site again.` },
			});
			await emitStep(submissionId, "failed", 100);
			return submissionId;
		} else if (decoy) {
			await SubmissionsEntity.update(submissionId, { status: "failed", info: caseFinding });
			await emitStep(submissionId, "failed", 100);
			return submissionId;
		} else {
			await SubmissionsEntity.update(submissionId, { status: "invalid", info: caseFinding });
		}

		await emitStep(submissionId, "completed", 100);
	} catch (error) {
		console.error("Website analysis failed:", error);
		await recordWebsiteAnalysisFailure(submissionId, error, priorAttempts);
		await emitStep(submissionId, "failed", 100);
	} finally {
		await closeSessions();
	}

	return submissionId;
}

/** What the report about one site's finding is built from: the page's own capture and what it sent off. */
function findingCapture(site: WebsiteChainSite) {
	const { archive } = site;
	return {
		commands: extractPasteCommands(archive.text.toString("utf-8")),
		navigationHops: archive.navigationHops,
		hiddenFrames: archive.hiddenFrames,
		device: archive.device,
		providerWarning: archive.providerWarning,
		offeredDownload: archive.offeredDownload,
		dataDrops: site.dataDrops,
	};
}

/** What the case says about one confirmed site: its report collecting evidence, or the open report of another case it joined. */
function reportOutcome(finding: ReportableWebsiteFinding, pageUrl: string, reportUrls: readonly string[], created: CreatedAbuseReport): string {
	const label = finding.finding === "malware" ? "Malware distribution" : "Phishing";
	const site = websiteSite(pageUrl);
	if (created.joined) return `${label} confirmed at ${pageUrl}; ${site} is already being reported in case ${created.joined.submissionId.toString()}, whose report now names this case too.`;
	const leading = reportUrls.length - 1;
	return leading === 0
		? `${label} confirmed at ${pageUrl}; its evidence is being collected before the report is sent.`
		: `${label} confirmed at ${pageUrl}; evidence for it and the ${leading} URL${leading === 1 ? "" : "s"} on ${site} that lead${leading === 1 ? "s" : ""} to it is being collected before the report is sent.`;
}

/**
 * The gate in front of a page about to be reported, read from the case's own
 * chain, with what a visitor without its session gets now. A page reached
 * directly is not requested again.
 */
async function reportAccessGate(chain: readonly WebsiteNavigationHop[], capturedUrl: string, userAgent: string | undefined, dependencies?: BareVisitDependencies) {
	const gate = accessGateOf(chain, capturedUrl);
	if (!gate) return undefined;
	const bareVisit = await checkBareVisit(capturedUrl, userAgent, dependencies);
	return bareVisit ? { ...gate, bareVisit } : gate;
}

/**
 * A website visit the server's restart cut off: queued for the automatic
 * retry like a browser-service failure. The retry boundary still refuses a
 * case that reached reporting, so nothing is reported twice.
 */
export async function retryInterruptedWebsiteAnalysis(submissionId: bigint): Promise<void> {
	const submission = await SubmissionsEntity.get(submissionId);
	if (submission?.data.kind !== "website") return;
	const reason = "The server restarted during the visit.";
	await failWebsiteAnalysis(submissionId, {
		info: reason,
		retry: { attempts: submission.data.website.autoRetry?.attempts ?? 0, reason, exhausted: (visits) => `It was cut off ${visits} times; retry to visit the site again.` },
	});
}

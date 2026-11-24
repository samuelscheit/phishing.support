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
import { analyzedCaptureStep, routeNames } from "../visit/capture_files";
import { extractPasteCommands } from "../../malware/paste_commands";
import { websiteSite } from "../info/site";
import { accessGateOf, checkBareVisit, type BareVisitDependencies } from "../visit/access_gate";
import { abuseEmailCaseUrl } from "../../abuse/mail/draft";
import { buildWebsiteAnalysisInput } from "./narrative";
import { buildWebsiteReportEvidence, classifiedHiddenFrame } from "./classification";
import type { ReportableWebsiteFinding, WebsiteDevice, WebsiteFunnel, WebsiteHiddenFrame, WebsiteKitResource, WebsiteNavigationHop, WebsiteRoute, WebsiteRouteVisitor } from "../types";
import { emitStep } from "../visit/progress";
import { capturedArchiveHop, reportableFinding, reportableWebsiteHop, unreportedVerdict, websiteReportUrls } from "../info/report_hops";
import { capturedPageScreenshots, capturedWebsiteData, websiteEvidence } from "./evidence";
import { visitWebsite, type WebsiteChainSite, type WebsiteVisitResult } from "../visit/visit";
import { firstWalkBrowser, ROTATION_EGRESS, sampleRotation, samplesRotation, type RotationBrowser } from "./rotation";
import type { FabricEgress } from "../../browser/fabric";
import type { FunnelChain } from "../../abuse/funnel/chain";
import type { DeceptiveFunnelFinding } from "../../abuse/funnel/classification";
import { cloakedDestinationInfo, cloakingSuspectedInfo, harmlessScriptedDestination } from "../archive/cloaking";
import { BROWSER_BACKOFF_MS, failWebsiteAnalysis, recordWebsiteAnalysisFailure, withBrowserBackoff } from "./failure";
import type { WebsiteAnalysisDependencies, WebsiteCapture } from "./analysis_types";
import { deceptiveFunnelFinding, funnelOutcomeText, judgeCaseFunnel, reportCaseFunnel } from "./funnel";

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
	// A sampled visit of a rotating link: every capture of its walk presents its browser, from the residential exit, in a
	// browser of its own (each Fabric lease is a fresh profile). A failure is not waited out: it ends the sampling.
	const sampleCapture = (browser: RotationBrowser) => async (captureOptions: ArchiveWebsiteOptions): Promise<WebsiteCapture> => {
		const captured = await (dependencies.archiveWebsite ?? archiveWebsite)({
			...captureOptions,
			...(browser.visitor ? { visitor: browser.visitor } : {}),
			...(browser.device && !captureOptions.device ? { device: browser.device } : {}),
			egress: ROTATION_EGRESS,
			keepSession: true,
		});
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
			await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await websiteEvidence(submissionId, url, archive, dependencies, 0) });
			await SubmissionsEntity.update(submissionId, {
				status: "failed",
				info: cloakingSuspectedInfo(archive.cloaking),
				data: { kind: "website", website: { url, whois, archiveUrl: archive.url, routes: [{ hops: archive.navigationHops }], cloaking: archive.cloaking } },
			});
			await emitStep(submissionId, "failed", 100);
			return submissionId;
		}
		const capturedHop = archive.attributionError ? undefined : capturedArchiveHop(archive);

		await emitStep(submissionId, "save_artifacts", 40);
		// A retry that reuses the stored capture keeps its original evidence package.
		if (!reuseEvidenceArtifacts) {
			await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await websiteEvidence(submissionId, url, archive, dependencies, 0) });
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
				website: { url, whois, ...capturedWebsiteData(archive), routes: [{ hops: archive.navigationHops, analyzedHopIndex: capturedHop.index }] },
			},
		});

		// Every walk of the link, the first one's as route 0: a link that rotates offers per click takes each walk down another.
		const walkRoute = async (route: number, first: WebsiteCapture, browser: RotationBrowser, walkCapture: typeof capture, networks?: readonly FabricEgress[]): Promise<WalkedRoute> => {
			const visited = await visitWebsite({ submissionId, route, url, whois, archive: first, dependencies, capture: walkCapture, ...(networks ? { networks, egress: networks[0] } : {}) }).finally(closeSessions);
			const confirmed = visited.reportable.flatMap((site) => {
				const hop = reportableWebsiteHop(site.archive.navigationHops, visited.assessments, site.archive);
				return hop ? [{ ...site, capturedHop: hop, capture: findingCapture(site) }] : [];
			});
			// The whole chain judged as one affiliate funnel, beside each site's own verdict: a lure that is no
			// phishing page may still mislead visitors through tracking links into a merchant's offer.
			const { chain: funnelChain, funnel } = await judgeCaseFunnel({ submissionId, chain: visited.chain, pages: visited.pages }, dependencies);
			const deceptive = funnel?.verdict.finding === "deceptive_funnel" ? { ...funnel, verdict: funnel.verdict } : undefined;
			const network = visited.archive.route ?? first.route;
			return { route, visitor: { browser: browser.label, ...(network ? { network } : {}) }, visited, confirmed, funnelChain, funnel, deceptive };
		};
		const firstBrowser = firstWalkBrowser(visitor);
		const walked = [await walkRoute(0, archive, firstBrowser, capture)];
		archive = walked[0]!.visited.archive;
		// A link whose first walk passed a tracking link may rotate: it is opened again, from the residential exit, as other browsers.
		const rotation = walked[0]!.funnel && samplesRotation(prior?.source) ? await sampleRotation({
			routes: [walked[0]!.visited.chain],
			first: firstBrowser,
			capture: async (browser) => {
				await emitStep(submissionId, "sample_rotation", 72);
				return sampleCapture(browser)({ url });
			},
			walk: async (first, browser, route) => {
				try {
					await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive: first, evidence: await websiteEvidence(submissionId, url, first, dependencies, route) });
				} catch (error) {
					// The residential exit is one connection: its browser is not held through the reporting that follows.
					await first.session?.close().catch(() => undefined);
					throw error;
				}
				const sampled = await walkRoute(route, first, browser, sampleCapture(browser), [ROTATION_EGRESS]);
				walked.push(sampled);
				return sampled.visited.chain;
			},
			...(dependencies.rotationBudgetMs !== undefined ? { budgetMs: dependencies.rotationBudgetMs } : {}),
		}) : undefined;

		const [firstRoute] = walked;
		const visited = firstRoute!.visited;
		const found = walked.some((route) => route.confirmed.length > 0 || route.deceptive !== undefined);
		// The case's headline: the first route with a reportable site, else the first that is a deceptive funnel, else the first walk.
		const headlineRoute = walked.find((route) => route.confirmed.length) ?? walked.find((route) => route.deceptive) ?? firstRoute!;
		const headline = headlineRoute.confirmed[0] ?? { archive: headlineRoute.visited.archive, capturedHop: headlineRoute.visited.capturedHop, classification: headlineRoute.visited.classification };
		// A scripted jump of the residential exit to a chain that shows nothing reportable led to a decoy.
		// A destination that turned every network away is said as such, not as a decoy.
		const decoy = !found && !visited.inconclusive && !visited.cloakedDestination && archive.cloaking?.outcome === "scripted" ? harmlessScriptedDestination(archive.cloaking) : undefined;
		const inconclusive = found ? undefined : visited.inconclusive
			&& `Inconclusive: the visit could not finish the site's flow: ${visited.inconclusive} The last page it reached, ${archive.url}, shows nothing reportable by itself; no verdict or report was made.`;
		// Each route found something of its own; with several, each finding names its route.
		const names = routeNames(walked.map((route) => route.visited.chain), websiteSite(url));
		const routeName = (route: WalkedRoute) => walked.length > 1 ? `Route ${route.route + 1} of ${walked.length}${names[route.route] ? `, via ${names[route.route]}` : ""}: ` : "";
		const routeFinding = (route: WalkedRoute) => [
			...(route.confirmed.length ? [`${route.confirmed.map((site) => buildWebsiteReportEvidence(site.classification, site.capture)).join("\n\n")}\n${route.confirmed.length === 1 ? "The site is reported to the responsible providers." : "Each of these sites is reported to its responsible providers."}`] : []),
			...(route.deceptive ? [deceptiveFunnelFinding(route.deceptive.verdict)] : []),
		].join("\n\n");
		const caseFinding = found
			? walked.filter((route) => route.confirmed.length || route.deceptive).map((route) => `${routeName(route)}${routeFinding(route)}`).join("\n\n")
			: decoy ? cloakingSuspectedInfo(decoy)
			: visited.cloakedDestination ? cloakedDestinationInfo(visited.cloakedDestination)
			: inconclusive ?? unreportedVerdict(visited.classification, archive.url);

		await emitStep(submissionId, "analysis_run", 75);
		await runStreamedAnalysisRun({
			submissionId,
			analysisKind: "analysis",
			options: {
				model: defaultResponseModel,
				input: buildWebsiteAnalysisInput(headline.archive, { finding: caseFinding, whois, pages: headlineRoute.visited.pages, visit: headlineRoute.visited.record, kitResources: headline.archive.kitResources, capturedAt: headline.archive.archivedAt, chain: headlineRoute.visited.chain }),
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
					routes: walked.map((route): WebsiteRoute => ({
						hops: route.visited.chain,
						analyzedHopIndex: (route.confirmed[0]?.capturedHop ?? route.visited.capturedHop).index,
						siteAssessments: route.visited.assessments,
						...(route.funnel ? { funnel: route.funnel } : {}),
						visit: route.visited.record,
						visitor: route.visitor,
					})),
					...(headlineRoute.route ? { analyzedRoute: headlineRoute.route } : {}),
					...(rotation ? { rotation } : {}),
					...(decoy ? { cloaking: decoy } : {}),
					...(visited.cloakedDestination ? { cloakedDestination: visited.cloakedDestination } : {}),
				},
			},
		});

		const reporter = { reporterIp, reporterCountry, reporterHeaders };
		if (found) {
			await emitStep(submissionId, "reporting", 90);
			const outcomes: string[] = [];
			let filed = false;
			for (const route of walked) {
				const reported = await reportRoute(route, { submissionId, reporter, headline: route === headlineRoute, dependencies });
				outcomes.push(...reported.outcomes.map((outcome) => `${routeName(route)}${outcome}`));
				filed ||= reported.filed;
			}
			// A case whose every finding was left out (each business of its funnel) is reported nowhere: it says so instead.
			if (!filed) {
				await SubmissionsEntity.update(submissionId, { status: "invalid", info: `${caseFinding}\n${outcomes.join("\n")}\nNo report was created.` });
				await emitStep(submissionId, "completed", 100);
				return submissionId;
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

/** One walk of the case's link, judged: its sites, the ones found reportable, and the route as a funnel. */
type WalkedRoute = {
	route: number;
	visitor: WebsiteRouteVisitor;
	visited: WebsiteVisitResult;
	confirmed: Array<WebsiteChainSite & { capturedHop: WebsiteNavigationHop; capture: ReturnType<typeof findingCapture> }>;
	funnelChain: FunnelChain;
	funnel?: WebsiteFunnel;
	deceptive?: WebsiteFunnel & { verdict: DeceptiveFunnelFinding };
};

/**
 * Report what one route found: each reportable site, deduplicated across
 * cases (and across this case's own routes: a site another route already
 * reported is that report), and each business of its deceptive funnel.
 * `filed` is false when nothing was reported or joined: every business of
 * its funnel was left out.
 */
async function reportRoute(walked: WalkedRoute, context: { submissionId: bigint; reporter: ReporterMetadata; headline: boolean; dependencies: WebsiteAnalysisDependencies }): Promise<{ outcomes: string[]; filed: boolean }> {
	const { submissionId, reporter, dependencies } = context;
	const { visited, route } = walked;
	const chain = visited.chain;
	// The reporter's browser is what the first walk presented; a sampled route was seen by a browser of ours.
	const reporterBrowser = route === 0 ? reporterBrowserIdentity(reporter.reporterHeaders) : undefined;
	const outcomes: string[] = [];
	let filed = false;
	// The walk's traffic goes with the first report of the route, whose investigation reports each data drop once;
	// for a site another case already reports, this case's own job reports them against that report.
	let trafficFiled = !visited.backends.length;
	for (const [position, site] of walked.confirmed.entries()) {
		const finding = reportableFinding(site.classification);
		const reportUrls = websiteReportUrls(chain, site.capturedHop);
		const accessGate = await reportAccessGate(chain, site.capturedHop.url, site.archive.userAgent, dependencies.bareVisit);
		// Kept with the case for answers to providers: the gate of the page its verdict rests on.
		if (accessGate && context.headline && position === 0) await SubmissionsEntity.setWebsiteField(submissionId, "accessGate", accessGate);
		const created = await reportConfirmedWebsiteAbuse({
			submissionId,
			urls: reportUrls,
			analysisText: buildWebsiteReportEvidence(site.classification, { ...site.capture, ...(reporterBrowser ? { reporterUserAgent: reporterBrowser.override.userAgent } : {}), accessGate, caseUrl: abuseEmailCaseUrl(submissionId) }),
			...(site.archive.userAgent ? { userAgent: site.archive.userAgent } : {}),
			screenshots: await capturedPageScreenshots(submissionId, { route, step: analyzedCaptureStep(site.archive.navigationHops) }),
			reporter,
			finding,
			pasteCommands: site.capture.commands,
			...(finding.finding === "malware" && site.archive.offeredDownload ? { offeredDownload: site.archive.offeredDownload } : {}),
			...(site.classification.impersonatedBrand ? { legalBrandUrl: site.classification.impersonatedBrand.officialUrl } : {}),
			...(site.classification.hiddenFrame ? { hiddenFrame: classifiedHiddenFrame(site.classification, site.archive.hiddenFrames)! } : {}),
			...(trafficFiled ? {} : { visitCapture: { canaries: visited.canaries, requests: visited.requests, backends: visited.backends } }),
		});
		trafficFiled ||= created.created || created.joined !== undefined;
		filed = true;
		outcomes.push(reportOutcome(finding, site.capturedHop.url, reportUrls, created));
	}
	if (walked.deceptive) {
		const funnelOutcomes = await reportCaseFunnel({ submissionId, chain: walked.funnelChain, funnel: walked.deceptive, reporter }, dependencies);
		outcomes.push(...funnelOutcomes.map(funnelOutcomeText));
		const skipped = funnelOutcomes.flatMap((outcome) => outcome.kind === "skipped" ? [{ site: outcome.site, role: outcome.role, reason: outcome.reason }] : []);
		if (skipped.length) await SubmissionsEntity.setWebsiteField(submissionId, `routes[${route}].funnel`, { ...walked.deceptive, skipped });
		filed ||= skipped.length < funnelOutcomes.length;
	}
	return { outcomes, filed };
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

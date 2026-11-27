import { createHash } from "node:crypto";

import { kitFingerprints, type KitFingerprint } from "../abuse/origin/siblings";
import { AbuseRepository } from "../abuse/repository";
import type { AbuseEvent } from "../abuse/schema";
import { reporterBrowserIdentity } from "../browser/reporter_identity";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import type { WebsiteSubmissionData } from "../db/schema";
import { readResponseBody } from "../network/bounded_fetch";
import { fetchThroughPublicRedirects } from "../network/public_redirects";
import { asRecord } from "../util/values";
import { createExfiltrationCanaries } from "../exfiltration/canaries";
import { taskAgentVisit, type VisitAgent } from "../site_visit/agent";
import { visitSite } from "../website/archive/visit_site";
import { WebsiteCaptureFailedError, WebsiteHostOfflineError } from "../website/archive/errors";
import type { WebsiteArchiveResult } from "../website/archive/types";
import type { WebsiteSiteClassification } from "../website/types";
import { capturedArchiveHop, isReportable } from "../website/info/report_hops";
import { isSameWebsite } from "../website/info/site";
import { htmlFingerprints, pageFingerprints, sharedPageFingerprints, type PageFingerprints } from "../website/page_fingerprint";
import { websiteRoutes } from "../website/routes";
import { chainHopBodyFileName, isPageHop, latestArtifactNamed, routePage, websiteCaptureFileNames } from "../website/visit/capture_files";
import { classifyCapturedPage } from "../website/visit/visit";
import { checkSite, type SiteCheckDependencies, type SiteCheckResult } from "./check";
import { distinctiveKitFiles, proofFilesOn, servedKitFiles, type IsSharedKitFile } from "./kit_files";
import { TAKEN_DOWN_STATES, type SiteCheckState } from "./schema";

/** The event that records one verification of what a reported site serves now. */
export const CONTENT_VERIFIED_EVENT = "site.content_verified";

const PAYLOAD_TIMEOUT_MS = 20_000;
/** Pages browsers confirmed are kept this many at most, newest first: a kit rotates through few versions. */
const MAX_LEARNED_PAGES = 10;
/** A payload larger than this is not the file the case downloaded and hashed. */
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** One fingerprint the site serves now that the case recorded when it was reported. */
export type ContentMatch = { kind: "kit_file" | "page_body" | "page_structure" | "payload"; sha256: string; url: string };

/**
 * Whether the reported site still serves what was reported, and the
 * cheapest way that was known:
 *
 * - `gone`: the registry or host took the site down (`TAKEN_DOWN_STATES`,
 *   `check`), or its host name is gone from DNS (`browser`: every route
 *   failed to reach it and public DNS confirmed NXDOMAIN).
 * - `served`: the site serves files or a page the case recorded, byte for
 *   byte or by template; `fetch` found it with plain requests, `browser`
 *   needed a browser like the case's (cloaking, script-built pages, a page
 *   the visiting agent reached).
 * - `changed_malicious`: the page changed, and the case's classifier still
 *   finds it (or a page the visiting agent reached from it) phishing or malware.
 * - `not_malicious`: the page changed, and the classifier finds nothing on it
 *   or on any page the visiting agent reached from it.
 * - `unverified`: nothing could be compared: the visit failed or the site
 *   showed every route a decoy.
 */
type ContentVerdict =
	| { verdict: "gone"; tier: "check" | "browser" }
	| { verdict: "served"; tier: "fetch" | "browser"; matches: ContentMatch[] }
	| { verdict: "changed_malicious"; tier: "analysis"; finding: string }
	| { verdict: "not_malicious"; tier: "analysis"; reason: string }
	| { verdict: "unverified"; tier: "fetch" | "browser" | "analysis"; reason: string };

export type ContentVerification = ContentVerdict & {
	url: string;
	checkedAt: string;
	/** The plain check's state and why. */
	state: SiteCheckState;
	detail: string | null;
	/** The page the browser got, as the server sent it: once confirmed, a plain request that gets the same is the site serving it. */
	observed?: PageFingerprints;
};

/** Whether the verification found the reported abuse still there. */
export const stillAbusive = (verification: Pick<ContentVerification, "verdict">): boolean => verification.verdict === "served" || verification.verdict === "changed_malicious";

/** What the case recorded of the reported site, to compare what it serves now with. */
type ContentReference = {
	/** Its pages as the server sent them: the case's document bodies, and those later verifications confirmed. */
	served: PageFingerprints[];
	/** Its pages as the case's browser stored them (MHTML). */
	rendered: PageFingerprints[];
	/** Scripts and hidden frames only its kit has, from any host. */
	kitFiles: KitFingerprint[];
	/** Files the report is about, as a downloader got them. */
	payloads: Array<{ url: string; sha256: string }>;
};

export type ContentVerificationDependencies = {
	site?: SiteCheckDependencies;
	/** The plain check of the URL when the caller made it just now; it is not made again. */
	check?: SiteCheckResult;
	/** The browser visit; production's is the case's own. */
	visitSite?: typeof visitSite;
	/** The agent that walks on from a changed page the classifier found nothing on; the browser task agent in production. */
	visitAgent?: VisitAgent;
	/** The page classifier; production's is the case's own. */
	classify?: (params: { submissionId: bigint; archive: WebsiteArchiveResult }) => Promise<Judgment>;
	isShared?: IsSharedKitFile;
};

/** The target whose primary reported URL is verified. */
export type ContentTarget = { reportId: bigint; targetId: bigint; url: string };

const verifiedEvents = (events: readonly AbuseEvent[], targetId: bigint) => events.filter((event) => event.eventType === CONTENT_VERIFIED_EVENT && event.targetId === targetId);

/** The verifications recorded for the target, oldest first; a record of another shape is skipped. */
export function contentVerificationsOf(events: readonly AbuseEvent[], targetId: bigint): ContentVerification[] {
	return verifiedEvents(events, targetId).flatMap((event) => {
		const data = asRecord(event.data);
		if (typeof data?.verdict !== "string" || typeof data.tier !== "string") return [];
		const observed = asRecord(data.observed);
		return [{ ...data, ...(observed ? { observed: observed as PageFingerprints } : { observed: undefined }) } as ContentVerification];
	});
}

/**
 * The raw pages browsers confirmed as the reported site's (it showed the
 * case's page or loaded the kit's own files), newest first. A page the
 * classifier judged is never one: it may be another kit, or a mistake.
 */
function learnedPages(events: readonly AbuseEvent[], targetId: bigint): PageFingerprints[] {
	const seen = new Set<string>();
	return contentVerificationsOf(events, targetId)
		.filter((verification) => verification.verdict === "served" && verification.tier === "browser" && verification.observed)
		.map((verification) => verification.observed!)
		.reverse()
		.filter((page) => {
			const key = `${page.body?.sha256 ?? ""}:${page.structure?.sha256 ?? ""}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, MAX_LEARNED_PAGES);
}

async function readArtifact(artifacts: ReadonlyArray<{ id: bigint | string; name: string | null }>, name: string): Promise<Buffer | undefined> {
	const meta = latestArtifactNamed(artifacts, name);
	const artifact = meta ? await ArtifactsEntity.get(BigInt(meta.id)) : undefined;
	return artifact ? Buffer.from(artifact.blob) : undefined;
}

/**
 * The case's captures of the pages it judged phishing or malware on the
 * reported site, on every route it walked. A decoy, error or parking page
 * the case also passed on that site is no evidence of the abuse.
 */
async function capturedPages(submissionId: bigint, website: WebsiteSubmissionData, url: string): Promise<Pick<ContentReference, "served" | "rendered">> {
	const artifacts = await ArtifactsEntity.listForSubmission(submissionId);
	const served: PageFingerprints[] = [];
	const rendered: PageFingerprints[] = [];
	for (const [route, { hops, siteAssessments = [] }] of websiteRoutes(website).entries()) {
		const judged = new Set(siteAssessments.filter(isReportable).map((assessment) => assessment.judgedHopIndex ?? assessment.hopIndex));
		for (const hop of hops.filter((candidate) => judged.has(candidate.index) && isSameWebsite(candidate.url, url))) {
			const body = hop.bodyCaptured ? await readArtifact(artifacts, chainHopBodyFileName(route, hop.index)) : undefined;
			if (body) served.push(htmlFingerprints(body.toString("utf8"), hop.url));
			const mhtml = isPageHop(hop) ? await readArtifact(artifacts, websiteCaptureFileNames(routePage(route, hops, hop)).mhtml) : undefined;
			if (mhtml) rendered.push(pageFingerprints(mhtml, hop.url));
		}
	}
	return { served, rendered };
}

/** The payload a payload-host report is about, from its original request. */
async function reportedPayloads(reportId: bigint): Promise<ContentReference["payloads"]> {
	const [request] = await AbuseRepository.listArtifacts(reportId, ["original_request"]);
	if (!request) return [];
	try {
		const original = asRecord(JSON.parse(Buffer.from(request.blob).toString("utf8")));
		const payload = asRecord(original?.payload);
		return original?.kind === "malware_payload_host" && typeof payload?.url === "string" && typeof payload.sha256 === "string" ? [{ url: payload.url, sha256: payload.sha256.toLowerCase() }] : [];
	} catch {
		return [];
	}
}

const hasFingerprint = (fingerprints: PageFingerprints) => Boolean(fingerprints.body || fingerprints.structure);

/** What the case recorded of the target's site, with the pages earlier verifications confirmed. */
async function loadContentReference(target: ContentTarget, website: WebsiteSubmissionData | undefined, submissionId: bigint | null, events: readonly AbuseEvent[], isShared?: IsSharedKitFile): Promise<ContentReference> {
	const pages = website && submissionId !== null ? await capturedPages(submissionId, website, target.url) : { served: [], rendered: [] };
	return {
		served: [...pages.served, ...learnedPages(events, target.targetId)].filter(hasFingerprint),
		rendered: pages.rendered.filter(hasFingerprint),
		kitFiles: website ? await distinctiveKitFiles(website, target.reportId, isShared) : [],
		payloads: await reportedPayloads(target.reportId),
	};
}

/** The pages of `reference` that `observed` is, as matches at `url`. */
function pageMatches(observed: PageFingerprints | null | undefined, references: readonly PageFingerprints[], url: string): ContentMatch[] {
	if (!observed) return [];
	const matches = new Map<string, ContentMatch>();
	for (const reference of references) {
		for (const kind of sharedPageFingerprints(observed, reference)) {
			const sha256 = kind === "page_body" ? observed.body!.sha256 : observed.structure!.sha256;
			matches.set(`${kind}:${sha256}`, { kind, sha256, url });
		}
	}
	return [...matches.values()];
}

/**
 * The hash of what a downloader gets at the payload's address now, or
 * undefined when it gets nothing. Any status with a body counts: the hash
 * proves the file, and payload hosts serve it under 403 or 404 too.
 */
async function payloadHash(url: string, userAgent: string | undefined, dependencies: SiteCheckDependencies): Promise<string | undefined> {
	try {
		const { response } = await fetchThroughPublicRedirects(url, {
			...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
			...(dependencies.assertPublicHost ? { assertPublicHost: dependencies.assertPublicHost } : {}),
			...(dependencies.signal ? { signal: dependencies.signal } : {}),
			subject: "reported payload",
			headers: { accept: "*/*", ...(userAgent ? { "user-agent": userAgent } : {}) },
			maxRedirects: 5,
			timeoutMs: PAYLOAD_TIMEOUT_MS,
		});
		const length = Number(response.headers.get("content-length") ?? 0);
		if ((response.status >= 300 && response.status < 400) || length > MAX_PAYLOAD_BYTES) {
			await response.body?.cancel().catch(() => undefined);
			return undefined;
		}
		return createHash("sha256").update(await readResponseBody(response, MAX_PAYLOAD_BYTES)).digest("hex");
	} catch {
		if (dependencies.signal?.aborted) throw dependencies.signal.reason;
		return undefined;
	}
}

/**
 * What plain requests find: the reported payload as a downloader gets it,
 * and the page as the check got it. The kit's own files on the host are
 * added as evidence once the page matched; alone they prove nothing, since
 * a file may outlive the page that loaded it.
 */
async function fetchMatches(target: ContentTarget, check: SiteCheckResult, reference: ContentReference, userAgent: string | undefined, dependencies: SiteCheckDependencies): Promise<ContentMatch[]> {
	const matches: ContentMatch[] = [];
	for (const payload of reference.payloads) {
		if ((await payloadHash(payload.url, userAgent, dependencies)) === payload.sha256) matches.push({ kind: "payload", sha256: payload.sha256, url: payload.url });
	}
	const pages = pageMatches(check.pageFingerprints, reference.served, check.finalUrl ?? target.url);
	if (!pages.length) return matches;
	const files = proofFilesOn(reference.kitFiles, new URL(target.url).hostname);
	const served = await servedKitFiles(target.url, files, dependencies);
	return [...matches, ...pages, ...served.map((file) => ({ kind: "kit_file" as const, ...file }))];
}

/** The raw document of the page the capture ended on, as the server sent it. */
function capturedDocument(archive: WebsiteArchiveResult): PageFingerprints | undefined {
	const hop = archive.navigationHops.findLast((candidate) => candidate.contentCaptured);
	const body = hop && archive.hopBodies?.find((candidate) => candidate.hopIndex === hop.index)?.body;
	const fingerprints = body ? htmlFingerprints(body.toString("utf8"), hop.url) : undefined;
	return fingerprints && hasFingerprint(fingerprints) ? fingerprints : undefined;
}

/** What a browser like the case's finds: the raw and the rendered page, and the kit's scripts and hidden frames from any host. */
function browserMatches(archive: WebsiteArchiveResult, reference: ContentReference, observed: PageFingerprints | undefined): ContentMatch[] {
	const kitHashes = new Set(reference.kitFiles.map((file) => file.sha256));
	return [
		...pageMatches(observed, reference.served, archive.url),
		...pageMatches(pageFingerprints(archive.mhtml, archive.url), reference.rendered, archive.url),
		...kitFingerprints(archive).filter((file) => kitHashes.has(file.sha256)).map((file) => ({ kind: "kit_file" as const, sha256: file.sha256, url: file.url })),
	];
}

async function defaultClassify({ submissionId, archive }: { submissionId: bigint; archive: WebsiteArchiveResult }) {
	const { classification } = await classifyCapturedPage(submissionId, capturedArchiveHop(archive), archive, {}, undefined);
	return { finding: classification.finding, ...(classification.rejectedClaim ? { reason: classification.rejectedClaim } : {}) };
}

/**
 * Find out whether the target's reported URL still serves what was
 * reported, from the cheapest evidence up, stopping at the first that
 * decides:
 *
 * 1. The plain check (DNS, RDAP, one request): a site the registry or host
 *    took down is gone.
 * 2. Plain requests: the page the check got, the kit's own files on the
 *    site's host and the reported payload, compared by hash with what the
 *    case recorded. A match needs no browser.
 * 3. A browser visit as the case made it (its browser, device and
 *    networks), its first page compared the same way, rendered page
 *    included. A host every route failed to reach that public DNS no longer
 *    knows is gone.
 * 4. When nothing matches, the case's classifier judges that first page
 *    (`maxTier: "analysis"` only). When it finds nothing, the visiting agent
 *    walks on from it in the same browser, as the case's visit did (a kit
 *    may hide its form behind a button or dialog now), and each page it
 *    reaches is compared, then judged, until one decides. It only reads:
 *    nothing is reported, and the case's own analysis stays as it is.
 *
 * Each verification is recorded as a `site.content_verified` event of the
 * target. A page a browser confirmed is kept with it, so the next plain
 * request that gets the same page needs no browser.
 */
export async function verifyReportedContent(
	target: ContentTarget,
	options: {
		maxTier?: "fetch" | "browser" | "analysis";
		signal?: AbortSignal;
		/** Record the verdict on the report (default). A check of another host against the report's content records nothing there. */
		record?: boolean;
	} = {},
	dependencies: ContentVerificationDependencies = {},
): Promise<ContentVerification> {
	const maxTier = options.maxTier ?? "analysis";
	const site: SiteCheckDependencies = { ...dependencies.site, ...(options.signal ? { signal: options.signal } : {}) };
	const [report, events] = await Promise.all([AbuseRepository.getReport(target.reportId), AbuseRepository.listEvents(target.reportId)]);
	const submission = report?.submissionId ? await SubmissionsEntity.get(report.submissionId) : undefined;
	const website = submission?.data.kind === "website" ? submission.data.website : undefined;
	const check = dependencies.check ?? await checkSite(target.url, site);
	const base = { url: target.url, checkedAt: check.checkedAt.toISOString(), state: check.state, detail: check.detail ?? null };
	const record = async (verdict: ContentVerdict, observed?: PageFingerprints): Promise<ContentVerification> => {
		const verification: ContentVerification = { ...base, ...verdict, ...(observed ? { observed } : {}) };
		if (options.record !== false) await AbuseRepository.appendEvent({ reportId: target.reportId, targetId: target.targetId, eventType: CONTENT_VERIFIED_EVENT, data: verification });
		return verification;
	};
	if (TAKEN_DOWN_STATES.includes(check.state)) return record({ verdict: "gone", tier: "check" });

	const reference = await loadContentReference(target, website, report?.submissionId ?? null, events, dependencies.isShared);
	const fetched = await fetchMatches(target, check, reference, report?.reportedUserAgent ?? undefined, site);
	if (fetched.length) return record({ verdict: "served", tier: "fetch", matches: fetched });
	if (maxTier === "fetch") return record({ verdict: "unverified", tier: "fetch", reason: "Plain requests got nothing the case recorded." });
	const recorded = reference.served.length + reference.rendered.length + reference.kitFiles.length;
	if (!recorded && maxTier === "browser") return record({ verdict: "unverified", tier: "fetch", reason: "The case recorded no page or kit file to compare with." });

	const classify = dependencies.classify ?? defaultClassify;
	/** A page the browser showed that the case recorded (its page, its kit's files): the site serves it still. */
	const matchPage = (archive: WebsiteArchiveResult): Decided | undefined => {
		const observed = capturedDocument(archive);
		const matches = browserMatches(archive, reference, observed);
		return matches.length ? { verdict: { verdict: "served", tier: "browser", matches }, observed } : undefined;
	};
	/** The classifier's verdict on a page the browser showed: reportable decides, anything else is its judgment. */
	const classifyPage = async (archive: WebsiteArchiveResult, submissionId: bigint): Promise<Decided | { judged: Judgment }> => {
		const judged = await classify({ submissionId, archive });
		return isReportable(judged) ? { verdict: { verdict: "changed_malicious", tier: "analysis", finding: judged.finding }, observed: capturedDocument(archive) } : { judged };
	};
	/** The verdict the first page decided, and the classifier's judgment of it when the walk goes on from it. */
	let decided: Decided | undefined;
	let firstJudged: Judgment | undefined;
	let visit;
	try {
		const visitor = reporterBrowserIdentity(report?.requesterHeaders ?? undefined);
		visit = await (dependencies.visitSite ?? visitSite)({
			url: target.url,
			...(visitor ? { visitor } : {}),
			...(website?.device ? { device: website.device } : {}),
			...(options.signal ? { signal: options.signal } : {}),
			// Deterministic first: a page the case recorded, or no case to judge with, ends the visit without any model.
			walk: async (initial) => {
				if (initial.cloaking?.outcome === "unresolved") {
					decided = { verdict: { verdict: "unverified", tier: "browser", reason: "The site showed every network a decoy." } };
					return undefined;
				}
				decided = matchPage(initial);
				if (decided) return undefined;
				if (maxTier === "browser") {
					decided = { verdict: { verdict: "unverified", tier: "browser", reason: "The browser got nothing the case recorded." } };
					return undefined;
				}
				if (!report?.submissionId) {
					decided = { verdict: { verdict: "unverified", tier: "analysis", reason: "The report has no case whose classifier could judge the page." } };
					return undefined;
				}
				const first = await classifyPage(initial, report.submissionId);
				if ("verdict" in first) {
					decided = first;
					return undefined;
				}
				// The page alone shows nothing reportable: the kit may hide its form behind a step, which the agent takes.
				firstJudged = first.judged;
				return { canaries: createExfiltrationCanaries(), agent: dependencies.visitAgent ?? taskAgentVisit() };
			},
		});
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason;
		if (error instanceof WebsiteHostOfflineError) return record({ verdict: "gone", tier: "browser" });
		if (error instanceof WebsiteCaptureFailedError) return record({ verdict: "unverified", tier: "browser", reason: `The browser could not load the page: ${error.message}` });
		throw error;
	}
	if (decided) return record(decided.verdict, decided.observed);
	// Only a first page the classifier judged harmless is walked on from; each page the walk reached decides in turn, cheapest first.
	const judged = firstJudged!;
	const steps = visit.recording?.steps ?? [];
	for (const { step } of steps) {
		const page = matchPage(step) ?? await classifyPage(step, report!.submissionId!);
		if ("verdict" in page) return record(page.verdict, page.observed);
	}
	const agent = visit.recording?.agent;
	if (agent && (agent.outcome !== "completed" || agent.report?.blockedByChallenge)) {
		const blocked = agent.report?.blockedByChallenge
			? `a CAPTCHA or browser check blocked the visit (${agent.report.stoppedReason})`
			: agent.failure ?? "the visiting agent did not finish the site's flow";
		return record({ verdict: "unverified", tier: "analysis", reason: `The first page showed nothing reportable, and ${blocked}.` });
	}
	const reason = judged.reason ?? `The page is classified ${judged.finding.replaceAll("_", " ")}.`;
	return record({ verdict: "not_malicious", tier: "analysis", reason: steps.length ? `${reason} Nothing reportable on the ${steps.length} page${steps.length === 1 ? "" : "s"} the visiting agent reached from it either.` : reason });
}

/** A verdict reached in the browser, with the raw page it rests on when that page is the site's. */
type Decided = { verdict: ContentVerdict; observed?: PageFingerprints };
/** The classifier's verdict on a page, as verification reads it. */
type Judgment = Pick<WebsiteSiteClassification, "finding"> & { reason?: string };

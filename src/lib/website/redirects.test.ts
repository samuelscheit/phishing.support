import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import type { AnalysisClient } from "../analysis/run";
import { AbuseRepository } from "../abuse/repository";
import { isKitSiblingSeed } from "../abuse/origin/kit_job";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import { createWebsiteSubmission, runDueWebsiteAutoRetries, websiteSubmissionDedupeKey } from "../submissions/website";
import type { WebsiteArchiveResult } from "./archive/types";
import { scriptedVisitSession } from "../site_visit/test_helpers";
import { analyzeWebsite } from "./ai";
import type { WebsiteAnalysisDependencies } from "./analysis_types";
import { capturedHostNavigation, websiteReportUrls, websiteSiteAssessments } from "./report_hops";
import type { WebsiteNavigationHop } from "./types";

useTemporaryDatabase();

const NETFLIX_TEXT = "Netflix\nSign In\nEmail or phone number\nPassword\nSign In";
const NETFLIX_HTML = '<html><head><title>Netflix</title></head><body><h1>Sign In</h1><input type="text" id="iduserLoginId" aria-label="Email or phone number"><input type="password" id="idpassword" aria-label="Password"><button>Sign In</button></body></html>';
const MHTML = Buffer.from("From: <Saved by Blink>\r\nContent-Type: text/html\r\n\r\n<html><body>Netflix</body></html>", "utf8");
const PNG = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#ffffff" } })
	.composite([{ input: { create: { width: 16, height: 8, channels: 3, background: "#202124" } }, top: 8, left: 8 }])
	.png().toBuffer();

function hop(index: number, url: string, status: number | null, redirectTo?: string): WebsiteNavigationHop {
	return { index, url, hostname: new URL(url).hostname, status, ...(redirectTo ? { redirectTo } : {}), contentCaptured: !redirectTo };
}

function archiveOf(hops: WebsiteNavigationHop[]): WebsiteArchiveResult {
	const captured = hops.at(-1)!;
	return {
		requestedUrl: hops[0]!.url,
		url: captured.url,
		hostname: captured.hostname,
		navigationHops: hops,
		archivedAt: new Date("2026-10-27T10:00:00Z"),
		screenshotPng: PNG,
		mhtml: MHTML,
		html: Buffer.from(NETFLIX_HTML, "utf8"),
		text: Buffer.from(NETFLIX_TEXT, "utf8"),
		// The visit finds nothing beyond the captured page.
		session: scriptedVisitSession(),
	};
}

/** Streams the classification the production model returned for submission 373426928255766528, then the narrative. */
function phishingModel(): AnalysisClient {
	return scriptedModel([
		JSON.stringify({ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign In Email or phone number Password", collectionFieldRefs: ["f1", "f2"], hiddenFrameRef: "", mobileHandoff: false }),
		"The captured page impersonates Netflix and asks for an email and password.",
	]);
}

/** Classifies the captured page as harmless, as the model did for the Wikipedia decoy of submission 376291398434951215. */
function benignModel(): AnalysisClient {
	return scriptedModel([
		JSON.stringify({ finding: "benign", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false }),
		"The page is a Wikipedia language and search landing page.",
	]);
}

function scriptedModel(outputs: string[]): AnalysisClient {
	let call = 0;
	return {
		responses: {
			create: async () => {
				const text = outputs[call++]!;
				return (async function* () {
					yield {
						type: "response.completed",
						response: { id: `response-${call}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 10 } },
					};
				})();
			},
		},
	} as unknown as AnalysisClient;
}

type ArchiveCall = Parameters<NonNullable<WebsiteAnalysisDependencies["archiveWebsite"]>>[0];

function dependencies(archive: WebsiteArchiveResult, archiveCalls: ArchiveCall[] = []): WebsiteAnalysisDependencies {
	return {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: phishingModel(),
		domainRegistration: async () => undefined,
		// Never reach a real time-stamping authority from a test.
		timestampEvidence: async () => undefined,
		// A gated page's direct visit answers with the page itself.
		bareVisit: { fetch: (async () => new Response("ok")) as unknown as typeof fetch, assertPublicHost: async () => {} },
		// A handed-over capture is parsed from its MHTML; the fake returns the
		// same evidence with the provenance it was given.
		archiveWebsite: async (options) => {
			archiveCalls.push(options);
			if (!options.mhtmlSnapshot) return archive;
			const navigationHops = options.navigationHops!;
			return { ...archive, requestedUrl: options.url, url: options.archivedUrl!, hostname: new URL(options.archivedUrl!).hostname, navigationHops, screenshotPng: undefined, kitResources: options.kitResources };
		},
	};
}

async function websiteSubmission(id: bigint, url: string) {
	return SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url } }, dedupeKey: websiteSubmissionDedupeKey(url), status: "running", source: url });
}

async function waitForStatus(id: bigint, statuses: string[]) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const submission = await SubmissionsEntity.get(id);
		if (submission && statuses.includes(submission.status)) return submission;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Submission ${id} did not reach ${statuses.join("/")}.`);
}

describe("a brand's own site on a domain other than its main one", () => {
	test("the classifier is given who holds the domain and a web search, and its benign verdict reports nothing", async () => {
		// Production case 381762485331432790: AWS GovCloud's own IAM sign-in was reported to AWS as an AWS lookalike.
		const url = "https://signin.amazonaws-us-gov.com/oauth?client_id=arn%3Aaws-us-gov%3Asignin%3A%3A%3Aconsole%2Fcanvas";
		const archive = archiveOf([hop(0, url, 200)]);
		const requests: Array<{ tools?: unknown; input?: unknown; text?: { format?: unknown } }> = [];
		const recording = benignModel();
		const analysisClient = { responses: { create: async (options: typeof requests[number]) => { requests.push(options); return recording.responses.create(options as never); } } } as unknown as AnalysisClient;
		const lookups: string[] = [];
		const domainRegistration = async (hostname: string) => {
			lookups.push(hostname);
			return { domain: "amazonaws-us-gov.com", registrar: "MarkMonitor", brandProtectionRegistrar: true, registrant: "Amazon Technologies, Inc.", registered: "2012-08-13", nameservers: ["ns-1063.awsdns-04.org"] };
		};
		const id = await websiteSubmission(381762485331432790n, url);

		await analyzeWebsite({ submissionId: id, url }, { ...dependencies(archive), analysisClient, domainRegistration });

		const classification = requests.find((request) => request.text?.format);
		expect(classification?.tools).toEqual([{ type: "web_search" }]);
		const [system, user] = classification!.input as [{ content: string }, { content: Array<{ text: string }> }];
		expect(system.content).toContain("A brand's own page is not phishing");
		expect(system.content).toContain("search the web for the brand's official domains");
		expect(user.content[0]!.text).toContain("domain_registration:");
		expect(user.content[0]!.text).toContain("registrant: \"Amazon Technologies, Inc.\"");
		expect(user.content[0]!.text).toContain("brandProtectionRegistrar: true");
		expect(lookups).toEqual(["signin.amazonaws-us-gov.com"]);
		expect((await SubmissionsEntity.get(id))?.status).toBe("invalid");
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
	});
});

describe("a submitted address that serves a file, not a page", () => {
	test("a kit's script shown as text is never classified or reported, however much its source names a login", async () => {
		// Production case 381800243735303166: the kit-sibling search submitted become.vigilant009.com/gmail/js/start.js,
		// and the classifier "quoted" `const lg = \`${root}/gmail-login\`;` as phishing page text.
		const url = "https://become.vigilant009.com/gmail/js/start.js";
		const source = "const root = location.origin;\nconst lg = `${root}/gmail-login`;\nfetch(lg).then((r) => r.text()).then((html) => document.write(html));";
		const archive = { ...archiveOf([{ ...hop(0, url, 200), contentType: "text/javascript; charset=utf-8" }]), html: Buffer.from(`<html><body><pre>${source}</pre></body></html>`), text: Buffer.from(source) };
		const requests: Array<{ text?: { format?: unknown } }> = [];
		const recording = scriptedModel(["The address serves a JavaScript file."]);
		const analysisClient = { responses: { create: async (options: { text?: { format?: unknown } }) => { requests.push(options); return recording.responses.create(options as never); } } } as unknown as AnalysisClient;
		const id = await websiteSubmission(381800243735303166n, url);

		await analyzeWebsite({ submissionId: id, url }, { ...dependencies(archive), analysisClient });

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("invalid");
		expect(submission?.info).toBe(`The classifier's finding for ${url} was not corroborated by the captured page: the captured address serves a file (text/javascript; charset=utf-8), not a web page a visitor is shown. No report was created.`);
		expect(requests.filter((request) => request.text?.format)).toEqual([]);
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
	});
});

describe("website redirects", () => {
	test("an IP-hosted kit reached through a same-host http→https redirect is reported with both URLs", async () => {
		const httpUrl = "http://85.215.226.225/Netflix/Home/login.php";
		const httpsUrl = "https://85.215.226.225/Netflix/Home/login.php";
		const archive = archiveOf([hop(0, httpUrl, 307, httpsUrl), hop(1, httpsUrl, 200)]);
		const id = await websiteSubmission(373426928255766528n, httpUrl);

		await analyzeWebsite({ submissionId: id, url: httpUrl }, dependencies(archive));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		expect(submission?.info).toBe(`Phishing confirmed at ${httpsUrl}; evidence for it and the 1 URL on 85.215.226.225 that leads to it is being collected before the report is sent.`);
		const website = submission?.data.kind === "website" ? submission.data.website : undefined;
		expect(website?.siteAssessments?.map(({ hopIndex, finding }) => ({ hopIndex, finding }))).toEqual([
			{ hopIndex: 0, finding: "phishing" },
			{ hopIndex: 1, finding: "phishing" },
		]);

		const report = await AbuseRepository.getReportForSubmission(id);
		const targets = await AbuseRepository.listTargets(report!.id);
		expect(targets.map(({ normalizedTarget, targetType, observedUrls }) => ({ normalizedTarget, targetType, observedUrls }))).toEqual([
			{ normalizedTarget: "85.215.226.225", targetType: "ip", observedUrls: [httpsUrl, httpUrl] },
		]);
	});

	test("a capture that ends on another host opens that host's case and links it from the submitted one", async () => {
		const shortUrl = "https://bit.ly/netflix-help";
		const kitStart = "http://login-netflix.example.com/";
		const kitPage = "https://login-netflix.example.com/signin";
		const kitResources = [{ url: "https://login-netflix.example.com/kit.js", mimeType: "application/javascript", size: 40_000, sha256: "a".repeat(64) }];
		const archive = { ...archiveOf([
			hop(0, shortUrl, 301, kitStart),
			hop(1, kitStart, 302, kitPage),
			hop(2, kitPage, 200),
		]), kitResources };
		const archiveCalls: ArchiveCall[] = [];
		const id = await websiteSubmission(1n, shortUrl);

		await analyzeWebsite({ submissionId: id, url: shortUrl }, dependencies(archive, archiveCalls));

		const parent = await SubmissionsEntity.get(id);
		expect(parent?.status).toBe("redirected");
		expect(parent?.info).toBe(`${shortUrl} redirects to login-netflix.example.com; that site is analyzed and reported in its own case.`);
		const parentWebsite = parent?.data.kind === "website" ? parent.data.website : undefined;
		expect(parentWebsite?.navigationHops).toEqual(archive.navigationHops);
		expect(parentWebsite?.siteAssessments).toBeUndefined();
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
		// The capture moves to the destination's case; the redirecting one keeps no copy.
		expect(await ArtifactsEntity.listForSubmission(id)).toEqual([]);

		const childId = BigInt(parentWebsite!.redirectSubmissionId!);
		const child = await waitForStatus(childId, ["reported", "failed", "invalid"]);
		expect(child.status).toBe("reported");
		expect(child.source).toBe(`redirect:${id}`);
		const childWebsite = child.data.kind === "website" ? child.data.website : undefined;
		expect(childWebsite?.url).toBe(kitStart);
		expect(childWebsite?.navigationHops).toEqual([
			{ ...hop(0, kitStart, 302, kitPage) },
			{ ...hop(1, kitPage, 200) },
		]);

		// The browser is not sent to the kit again: the parent's capture is reused.
		expect(archiveCalls).toHaveLength(2);
		expect(archiveCalls[1]).toMatchObject({ url: kitStart, archivedUrl: kitPage, mhtmlSnapshot: MHTML, kitResources });
		// The kit's captured file hashes move with the capture, so its case can search for siblings.
		expect(childWebsite?.kitResources).toEqual(kitResources);
		// The capture moves with its evidence package (the stamped screenshot and the manifest) and the visit's record.
		expect((await ArtifactsEntity.listForSubmission(childId)).map((artifact) => artifact.name).sort()).toEqual(["evidence-manifest.json", "visit-manifest.json", "visit-protocol.txt", "visit-record.json", "website-stamped.png", "website.mhtml", "website.png"]);

		const report = await AbuseRepository.getReportForSubmission(childId);
		const targets = await AbuseRepository.listTargets(report!.id);
		expect(targets.map(({ normalizedTarget, observedUrls }) => ({ normalizedTarget, observedUrls }))).toEqual([
			{ normalizedTarget: "login-netflix.example.com", observedUrls: [kitPage, kitStart] },
		]);
		// Its campaign's kit search may start from it: an original report's site.
		expect(await isKitSiblingSeed(childId)).toBe(true);
	});

	test("a redirect to a host that already has a case links the existing case instead of duplicating it", async () => {
		const kitPage = "https://kit.example.net/login";
		const existingId = await SubmissionsEntity.create({
			id: 50n,
			kind: "website",
			data: { kind: "website", website: { url: kitPage } },
			dedupeKey: "website-kit.example.net",
			status: "reported",
		});
		const archive = archiveOf([hop(0, "https://short.example.org/x", 302, kitPage), hop(1, kitPage, 200)]);
		const archiveCalls: ArchiveCall[] = [];
		const id = await websiteSubmission(2n, "https://short.example.org/x");

		await analyzeWebsite({ submissionId: id, url: "https://short.example.org/x" }, dependencies(archive, archiveCalls));

		const parent = await SubmissionsEntity.get(id);
		expect(parent?.status).toBe("redirected");
		expect(parent?.data.kind === "website" ? parent.data.website.redirectSubmissionId : undefined).toBe(existingId.toString());
		expect(archiveCalls).toHaveLength(1);
	});

	test("a second site on a shared host opens its own case and is reported on its own", async () => {
		const reported = "https://sites.google.com/view/start-trezor-suite";
		const existingId = await createWebsiteSubmission({ url: reported }, async () => undefined);
		await SubmissionsEntity.update(existingId, { status: "reported" });

		const url = "https://sites.google.com/view/revert-change";
		const page = "https://sites.google.com/view/revert-change/login";
		const id = await createWebsiteSubmission({ url }, (options) => analyzeWebsite(options, dependencies(archiveOf([hop(0, url, 302, page), hop(1, page, 200)]))));
		expect(id).not.toBe(existingId);
		// The same site submitted again still lands on its own case.
		expect(await createWebsiteSubmission({ url: "https://sites.google.com/view/Revert-Change/" }, async () => undefined)).toBe(id);

		const submission = await waitForStatus(id, ["reported", "failed", "invalid", "redirected"]);
		expect(submission.status).toBe("reported");
		expect(submission.info).toBe(`Phishing confirmed at ${page}; evidence for it and the 1 URL on sites.google.com/view/revert-change that leads to it is being collected before the report is sent.`);
		const report = await AbuseRepository.getReportForSubmission(id);
		const targets = await AbuseRepository.listTargets(report!.id);
		expect(targets.map(({ normalizedTarget, observedUrls }) => ({ normalizedTarget, observedUrls }))).toEqual([
			{ normalizedTarget: "sites.google.com", observedUrls: [page, url] },
		]);
	});

	test("a redirect from one tenant of a shared host to another hands off to the other tenant's case", async () => {
		const url = "https://sites.google.com/view/landing";
		const kitPage = "https://sites.google.com/view/wallet-restore/home";
		const id = await websiteSubmission(3n, url);

		await analyzeWebsite({ submissionId: id, url }, dependencies(archiveOf([hop(0, url, 302, kitPage), hop(1, kitPage, 200)])));

		const parent = await SubmissionsEntity.get(id);
		expect(parent?.status).toBe("redirected");
		expect(parent?.info).toBe(`${url} redirects to sites.google.com/view/wallet-restore; that site is analyzed and reported in its own case.`);
		const child = await waitForStatus(BigInt(parent!.data.kind === "website" ? parent!.data.website.redirectSubmissionId! : "0"), ["reported", "failed", "invalid"]);
		expect(child.status).toBe("reported");
		expect(child.data.kind === "website" ? child.data.website.navigationHops?.map((hop) => hop.url) : undefined).toEqual([kitPage]);
	});
});

describe("same-host navigation", () => {
	const hops = [
		hop(0, "https://bit.ly/a", 301, "http://kit.example.com/"),
		hop(1, "http://kit.example.com/", 302, "https://kit.example.com/"),
		hop(2, "https://kit.example.com/", 302, "https://www.kit.example.com/login"),
		hop(3, "https://www.kit.example.com/login", 200),
	];

	test("only an exact hostname counts as the same site", () => {
		expect(capturedHostNavigation(hops, hops[3]!)).toEqual([{ ...hops[3]!, index: 0 }]);
		expect(websiteReportUrls(hops, hops[3]!)).toEqual(["https://www.kit.example.com/login"]);
	});

	test("the trailing same-host run is re-indexed as if submitted directly", () => {
		const sameHost = hops.slice(0, 3).concat({ ...hop(3, "https://kit.example.com/login", 200) });
		expect(capturedHostNavigation(sameHost, sameHost[3]!).map(({ index, url }) => ({ index, url }))).toEqual([
			{ index: 0, url: "http://kit.example.com/" },
			{ index: 1, url: "https://kit.example.com/" },
			{ index: 2, url: "https://kit.example.com/login" },
		]);
		expect(websiteReportUrls(sameHost, sameHost[3]!)).toEqual([
			"https://kit.example.com/login",
			"http://kit.example.com/",
			"https://kit.example.com/",
		]);
	});

	test("same-host redirect hops share the captured finding; other hosts never inherit it", () => {
		const sameHost = hops.slice(0, 3).concat({ ...hop(3, "https://kit.example.com/login", 200) });
		const assessments = websiteSiteAssessments(sameHost, 3, { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign In" });
		expect(assessments.map(({ hopIndex, finding }) => ({ hopIndex, finding }))).toEqual([
			{ hopIndex: 0, finding: "insufficient_evidence" },
			{ hopIndex: 1, finding: "phishing" },
			{ hopIndex: 2, finding: "phishing" },
			{ hopIndex: 3, finding: "phishing" },
		]);
	});
});

test("a new website submission hands its options to the analysis it starts", async () => {
	const started: unknown[] = [];
	const id = await createWebsiteSubmission({ url: "https://fresh.example.com/" }, async (options) => started.push(options));
	expect(started).toEqual([{ submissionId: id, url: "https://fresh.example.com/" }]);
});

describe("cloaked websites", () => {
	const cloakerUrl = "https://lookup-lgr.to/en/verification";
	const kitUrl = "https://device.ledger-config.live/en";
	const decoyUrl = "https://www.wikipedia.org/";

	test("a cloaker whose residential capture reached the kit hands that kit to its own case and says why", async () => {
		const detail = `${cloakerUrl} sent the Tor exit to wikipedia.org but the residential exit to ledger-config.live`;
		const archive = { ...archiveOf([hop(0, cloakerUrl, 200, kitUrl), hop(1, kitUrl, 200)]), cloaking: { outcome: "detected" as const, detail } };
		const id = await websiteSubmission(374589286864916480n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, dependencies(archive));

		const parent = await SubmissionsEntity.get(id);
		expect(parent?.status).toBe("redirected");
		expect(parent?.info).toBe(`${cloakerUrl} cloaks: ${detail}. device.ledger-config.live is analyzed in its own case. If it shows nothing reportable, ${cloakerUrl} is treated as a cloaker that turned every route away.`);
		const website = parent?.data.kind === "website" ? parent.data.website : undefined;
		expect(website?.cloaking).toEqual({ outcome: "detected", detail });
		const childId = BigInt(website?.redirectSubmissionId ?? "0");
		expect((await waitForStatus(childId, ["reported", "failed", "invalid"])).status).toBe("reported");
		expect((await SubmissionsEntity.get(id))?.status).toBe("redirected");
	});

	test("a cloaker that sent the residential exit to another harmless site fails as suspected cloaking, not as a redirect", async () => {
		// docusign.alt3-doc3ea7-v2.sbs (submission 376813288618463354) answers every
		// visit with `location.replace` to a random news front page.
		const submitted = "https://docusign.alt3-doc3ea7-v2.sbs/word/verify.workspace.php";
		const residentialDecoy = "https://www.bbc.com/";
		const detail = `${submitted} sent the Tor exit to reuters.com but the residential exit to bbc.com`;
		const archive = { ...archiveOf([hop(0, submitted, 200, residentialDecoy), hop(1, residentialDecoy, 200)]), cloaking: { outcome: "detected" as const, detail } };
		const id = await websiteSubmission(376813288618463354n, submitted);

		await analyzeWebsite({ submissionId: id, url: submitted }, { ...dependencies(archive), analysisClient: benignModel() });

		const handedOff = await SubmissionsEntity.get(id);
		const childId = BigInt(handedOff?.data.kind === "website" ? handedOff.data.website.redirectSubmissionId! : "0");
		expect((await waitForStatus(childId, ["reported", "failed", "invalid"])).status).toBe("invalid");
		const parent = await waitForStatus(id, ["failed"]);
		expect(parent.info).toBe(`Cloaking suspected: ${detail}, which shows nothing reportable. No verdict or report was made from the decoy; retry to visit the site again.`);
		const website = parent.data.kind === "website" ? parent.data.website : undefined;
		expect(website?.cloaking).toEqual({ outcome: "unresolved", detail: `${detail}, which shows nothing reportable` });
		expect(website?.redirectSubmissionId).toBe(childId.toString());
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
		expect(await AbuseRepository.getReportForSubmission(childId)).toBeUndefined();
	});

	test("a decoy-only capture is kept as evidence but never classified or reported as not phishing", async () => {
		const detail = `${cloakerUrl} sent the Tor exit to wikipedia.org by script, and the residential exit could not check what other visitors see (offline)`;
		const archive = { ...archiveOf([hop(0, cloakerUrl, 200, decoyUrl), hop(1, decoyUrl, 200)]), cloaking: { outcome: "unresolved" as const, detail } };
		let modelCalls = 0;
		const deps = { ...dependencies(archive), analysisClient: { responses: { create: async () => { modelCalls++; throw new Error("must not classify a decoy"); } } } as unknown as AnalysisClient };
		const id = await websiteSubmission(2n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, deps);

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("failed");
		expect(submission?.info).toBe(`Cloaking suspected: ${detail}. No verdict or report was made from the decoy; retry to visit the site again.`);
		const website = submission?.data.kind === "website" ? submission.data.website : undefined;
		expect(website?.cloaking).toEqual({ outcome: "unresolved", detail });
		expect(website?.redirectSubmissionId).toBeUndefined();
		expect(modelCalls).toBe(0);
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
		// The decoy is kept with its evidence package, so it is documented like any capture.
		expect((await ArtifactsEntity.listForSubmission(id)).map((artifact) => artifact.kind).filter((kind) => kind !== "website_evidence").sort()).toEqual(["website_mhtml", "website_png"]);
	});
});

describe("scripted jumps every route followed to the same site", () => {
	const cloakerUrl = "https://apple-condition.com/en/verification";
	const decoyUrl = "https://www.wikipedia.org/";
	const kitUrl = "https://login-netflix.example.com/signin";
	const uniform = (destination: string, submitted = cloakerUrl) => ({
		outcome: "uniform" as const,
		detail: `${submitted} sent both the Tor exit and the residential exit to ${new URL(destination).hostname.replace(/^www\./, "")} by script`,
	});
	const uniformArchive = (destination: string, submitted = cloakerUrl) => ({ ...archiveOf([hop(0, submitted, 200, destination), hop(1, destination, 200)]), cloaking: uniform(destination, submitted) });

	test("a harmless destination fails the submitted case as suspected cloaking, retryable, with the destination's case kept", async () => {
		const archive = uniformArchive(decoyUrl);
		const id = await websiteSubmission(376291398434951215n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, { ...dependencies(archive), analysisClient: benignModel() });

		const handedOff = await SubmissionsEntity.get(id);
		const childId = BigInt(handedOff?.data.kind === "website" ? handedOff.data.website.redirectSubmissionId! : "0");
		expect((await waitForStatus(childId, ["reported", "failed", "invalid"])).status).toBe("invalid");
		const parent = await waitForStatus(id, ["failed"]);
		const detail = `${uniform(decoyUrl).detail}, which shows nothing reportable`;
		expect(parent.info).toBe(`Cloaking suspected: ${detail}. No verdict or report was made from the decoy; retry to visit the site again.`);
		const website = parent.data.kind === "website" ? parent.data.website : undefined;
		expect(website?.cloaking).toEqual({ outcome: "unresolved", detail });
		expect(website?.redirectSubmissionId).toBe(childId.toString());
		expect(website?.navigationHops).toEqual(archive.navigationHops);
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
		expect(await AbuseRepository.getReportForSubmission(childId)).toBeUndefined();
	});

	test("a page reached only through an entry's one-time link is reported with how to reach it and what a direct visit gets", async () => {
		// Production case 381727464776274088: Cloudflare opened lbbvw.com/ without the session and found nothing.
		const entry = "https://f24ac216.37b963ba383fc01de7edcef8.workers.dev/";
		const ticket = "https://lbbvw.com/?dataXX0=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1cmwiOiJodHRwczovL2xiYnZ3LmNvbS8iLCJkb21haW4iOiJsYmJ2dy5jb20iLCJrZXkiOiJTUlZ3UWJuZjAzb2QiLCJxcmMiOm51bGwsImlhdCI6MTc5NTA3ODA2MCwiZXhwIjoxNzk1MDc4MTgwfQ.qAQe7AM6yZdPpNWwd5ao1NTlafcHGAFeYM_Ue6L02qA";
		const page = "https://lbbvw.com/";
		const id = await websiteSubmission(70n, entry);
		const archive = archiveOf([{ ...hop(0, entry, 200, entry), visitorStep: { submitted: [] } }, hop(1, entry, 302, ticket), hop(2, ticket, 302, page), hop(3, page, 200)]);
		const bareRequests: string[] = [];
		const decoy = (async (input: URL | RequestInfo) => {
			bareRequests.push(String(input));
			return String(input) === page ? new Response(null, { status: 302, headers: { location: "https://href.li/?https://example.com" } }) : new Response("ok");
		}) as typeof fetch;

		await analyzeWebsite({ submissionId: id, url: entry }, { ...dependencies(archive), bareVisit: { fetch: decoy, assertPublicHost: async () => {} } });

		const parent = await SubmissionsEntity.get(id);
		const childId = BigInt(parent!.data.kind === "website" ? parent!.data.website.redirectSubmissionId! : "0");
		expect((await waitForStatus(childId, ["reported", "failed", "invalid"])).status).toBe("reported");
		const report = await AbuseRepository.getReportForSubmission(childId);
		expect(report!.description).toContain(`Victims are sent to ${entry}, a link on another site, which first has them pass a check page of its own and then forwards each of them to lbbvw.com.`);
		expect(report!.description).toContain("one-time link whose token is valid for only 2 minutes");
		expect(report!.description).toContain(`Opened without that session, ${page} sends visitors to https://href.li/?https://example.com`);
		expect(report!.description).toContain(`To see the page, follow ${entry} in a browser and continue straight through; our capture of what victims see, with screenshots, is at `);
		// Kept with the case for answers to providers; the page was requested once, without a session.
		const child = await SubmissionsEntity.get(childId);
		expect(child?.data.kind === "website" ? child.data.website.accessGate : undefined).toMatchObject({ entryUrl: entry, entryStep: true, ticket: { lifetimeSeconds: 120 }, bareVisit: { url: page, reachedUrl: "https://href.li/?https://example.com" } });
		expect(bareRequests).toEqual([page, "https://href.li/?https://example.com"]);
	});

	test("a phishing destination keeps the submitted case redirected to the reported case", async () => {
		const id = await websiteSubmission(10n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, dependencies(uniformArchive(kitUrl)));

		const parent = await SubmissionsEntity.get(id);
		expect(parent?.status).toBe("redirected");
		expect(parent?.info).toBe(`${uniform(kitUrl).detail}; that site is analyzed in its own case. If it shows nothing reportable, ${cloakerUrl} is treated as a cloaker that turned every route away.`);
		const childId = BigInt(parent!.data.kind === "website" ? parent!.data.website.redirectSubmissionId! : "0");
		expect((await waitForStatus(childId, ["reported", "failed", "invalid"])).status).toBe("reported");
		const settled = await SubmissionsEntity.get(id);
		expect(settled?.status).toBe("redirected");
		expect(settled?.data.kind === "website" ? settled.data.website.cloaking : undefined).toEqual(uniform(kitUrl));
	});

	test("a destination whose case already found nothing fails the submitted case at once, without analyzing the decoy again", async () => {
		await SubmissionsEntity.create({ id: 60n, kind: "website", data: { kind: "website", website: { url: decoyUrl } }, dedupeKey: websiteSubmissionDedupeKey(decoyUrl), status: "invalid" });
		const archiveCalls: ArchiveCall[] = [];
		const id = await websiteSubmission(11n, cloakerUrl);

		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, dependencies(uniformArchive(decoyUrl), archiveCalls));

		const parent = await SubmissionsEntity.get(id);
		expect(parent?.status).toBe("failed");
		expect(parent?.data.kind === "website" ? parent.data.website.cloaking?.outcome : undefined).toBe("unresolved");
		expect(archiveCalls).toHaveLength(1);
	});

	test("a destination whose case is still running settles every case waiting on it once it finds nothing", async () => {
		const decoyId = await SubmissionsEntity.create({ id: 61n, kind: "website", data: { kind: "website", website: { url: decoyUrl } }, dedupeKey: websiteSubmissionDedupeKey(decoyUrl), status: "running" });
		const siblingUrl = "https://apple-conditions.com/en/verification";
		const plainUrl = "https://short.example.org/wiki";
		const first = await websiteSubmission(12n, cloakerUrl);
		const sibling = await websiteSubmission(13n, siblingUrl);
		const plain = await websiteSubmission(14n, plainUrl);

		await analyzeWebsite({ submissionId: first, url: cloakerUrl }, dependencies(uniformArchive(decoyUrl)));
		await analyzeWebsite({ submissionId: sibling, url: siblingUrl }, dependencies(uniformArchive(decoyUrl, siblingUrl)));
		// An HTTP redirect is the host's declared destination, never a cloaking suspicion.
		await analyzeWebsite({ submissionId: plain, url: plainUrl }, dependencies(archiveOf([hop(0, plainUrl, 302, decoyUrl), hop(1, decoyUrl, 200)])));
		for (const id of [first, sibling, plain]) expect((await SubmissionsEntity.get(id))?.status).toBe("redirected");

		await analyzeWebsite({ submissionId: decoyId, url: decoyUrl }, { ...dependencies(archiveOf([hop(0, decoyUrl, 200)])), analysisClient: benignModel() });

		expect((await SubmissionsEntity.get(decoyId))?.status).toBe("invalid");
		expect((await SubmissionsEntity.get(first))?.status).toBe("failed");
		expect((await SubmissionsEntity.get(sibling))?.info).toStartWith(`Cloaking suspected: ${siblingUrl} sent both`);
		expect((await SubmissionsEntity.get(plain))?.status).toBe("redirected");
	});

	test("a destination whose analysis fails leaves the submitted case redirected", async () => {
		const decoyId = await SubmissionsEntity.create({ id: 62n, kind: "website", data: { kind: "website", website: { url: decoyUrl } }, dedupeKey: websiteSubmissionDedupeKey(decoyUrl), status: "running" });
		const id = await websiteSubmission(15n, cloakerUrl);
		await analyzeWebsite({ submissionId: id, url: cloakerUrl }, dependencies(uniformArchive(decoyUrl)));

		await analyzeWebsite({ submissionId: decoyId, url: decoyUrl }, { ...dependencies(archiveOf([hop(0, decoyUrl, 200)])), archiveWebsite: async () => { throw new Error("site blocked every egress"); } });

		expect((await SubmissionsEntity.get(decoyId))?.status).toBe("failed");
		expect((await SubmissionsEntity.get(id))?.status).toBe("redirected");
	});
});

describe("browser-service failures", () => {
	const url = "https://app.karntappkrakurl.es/naivator/captcha/sign-in.php";
	// What puppeteer under Bun rejects with when the relay is full: an ErrorEvent, not an Error.
	const relayFull = () => Object.assign(new Event("error"), { message: "Unexpected server response: 503" });

	test("a capture that loses the browser is retried with backoff and then succeeds", async () => {
		const archive = archiveOf([hop(0, url, 200)]);
		let attempts = 0;
		const id = await websiteSubmission(374703356112802863n, url);

		await analyzeWebsite({ submissionId: id, url }, {
			...dependencies(archive),
			browserBackoffMs: [1, 1, 1],
			archiveWebsite: async () => {
				attempts++;
				if (attempts === 1) throw relayFull();
				if (attempts === 2) throw new Error("Protocol error (Target.getBrowserContexts): Target closed");
				return archive;
			},
		});

		expect(attempts).toBe(3);
		expect((await SubmissionsEntity.get(id))?.status).toBe("reported");
	});

	test("a lasting browser outage fails with a readable reason and is retried automatically, at most three times", async () => {
		const id = await websiteSubmission(374703356112802864n, url);
		const failing = { ...dependencies(archiveOf([hop(0, url, 200)])), browserBackoffMs: [1], archiveWebsite: async () => { throw relayFull(); } };
		const run = () => analyzeWebsite({ submissionId: id, url }, failing);
		const autoRetryOf = async () => {
			const submission = (await SubmissionsEntity.get(id))!;
			return { submission, autoRetry: submission.data.kind === "website" ? submission.data.website.autoRetry : undefined };
		};

		await run();
		let { submission, autoRetry } = await autoRetryOf();
		expect(submission.status).toBe("failed");
		expect(submission.info).toStartWith("The browser service failed (Unexpected server response: 503). Retrying automatically at ");
		expect(submission.info).toEndWith(" UTC (attempt 1 of 3).");
		expect(submission.info).not.toContain("[object");
		expect(autoRetry).toMatchObject({ attempts: 1, reason: "Unexpected server response: 503" });
		const dueAt = new Date(autoRetry!.nextAttemptAt);
		expect(dueAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

		// Not due yet: nothing is started.
		const started: bigint[] = [];
		const startAnalysis = async (options: { submissionId: bigint }) => { started.push(options.submissionId); };
		expect(await runDueWebsiteAutoRetries({ now: new Date(dueAt.getTime() - 1_000), startAnalysis })).toBe(0);
		// Due: re-queued through the normal retry boundary.
		expect(await runDueWebsiteAutoRetries({ now: dueAt, startAnalysis })).toBe(1);
		expect(started).toEqual([id]);
		expect((await SubmissionsEntity.get(id))?.status).toBe("running");

		// The second and third outages keep counting; the fourth gives up.
		await run();
		expect((await autoRetryOf()).autoRetry?.attempts).toBe(2);
		await run();
		expect((await autoRetryOf()).autoRetry?.attempts).toBe(3);
		await run();
		({ submission, autoRetry } = await autoRetryOf());
		expect(submission.status).toBe("failed");
		expect(submission.info).toBe("The browser service failed (Unexpected server response: 503). It failed 4 times in a row; retry once it has recovered.");
		expect(autoRetry).toBeUndefined();
		expect(await runDueWebsiteAutoRetries({ now: new Date(Date.now() + 24 * 60 * 60_000), startAnalysis })).toBe(0);
	});

	test("a due retry the retry boundary refuses, because the case was reported, is dropped instead of being refused on every pass", async () => {
		const id = await websiteSubmission(374703356112802866n, "https://netflix-reported-before.com/");
		await analyzeWebsite({ submissionId: id, url: "https://netflix-reported-before.com/" }, dependencies(archiveOf([hop(0, "https://netflix-reported-before.com/", 200)])));
		const reported = await SubmissionsEntity.get(id);
		expect({ status: reported?.status, info: reported?.info }).toEqual({ status: "reported", info: expect.any(String) });
		// As if a later analysis of the reported case had stopped unfinished.
		const website = (await SubmissionsEntity.get(id))!.data;
		const dueAt = new Date("2026-11-15T01:30:00Z");
		await SubmissionsEntity.update(id, { status: "failed", data: { kind: "website", website: { ...(website.kind === "website" ? website.website : { url: "" }), autoRetry: { attempts: 1, nextAttemptAt: dueAt.toISOString(), reason: "The visit's 8-minute budget ended the walk." } } } });

		const started: bigint[] = [];
		const startAnalysis = async (options: { submissionId: bigint }) => { started.push(options.submissionId); };
		expect(await runDueWebsiteAutoRetries({ now: dueAt, startAnalysis })).toBe(0);
		expect(started).toEqual([]);
		const after = await SubmissionsEntity.get(id);
		expect(after?.status).toBe("failed");
		expect(after?.data.kind === "website" ? after.data.website.autoRetry : "none").toBeUndefined();
		expect(await SubmissionsEntity.listDueWebsiteAutoRetries(new Date(dueAt.getTime() + 60_000))).toEqual([]);
	});

	test("a site that blocks every egress is final: no backoff and no automatic retry", async () => {
		const id = await websiteSubmission(374703356112802865n, url);
		let attempts = 0;
		await analyzeWebsite({ submissionId: id, url }, {
			...dependencies(archiveOf([hop(0, url, 200)])),
			browserBackoffMs: [1, 1, 1],
			archiveWebsite: async () => {
				attempts++;
				throw new Error('Failed to load page: HTTP 403 ("Attention Required! | Cloudflare") via Tor exit; HTTP 403 via server IP');
			},
		});
		const submission = (await SubmissionsEntity.get(id))!;
		expect(attempts).toBe(1);
		expect(submission.status).toBe("failed");
		expect(submission.info).toBe('Failed to load page: HTTP 403 ("Attention Required! | Cloudflare") via Tor exit; HTTP 403 via server IP');
		expect(submission.data.kind === "website" ? submission.data.website.autoRetry : "not website").toBeUndefined();
	});
});

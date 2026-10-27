import { describe, expect, test } from "bun:test";

import type { AnalysisClient } from "./analysis_run";
import { AbuseRepository } from "./abuse/repository";
import { ArtifactsEntity, SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { createWebsiteSubmission } from "./submissions/website";
import type { WebsiteArchiveResult } from "./website_archive";
import { analyzeWebsite, capturedHostNavigation, websiteReportUrls, websiteSiteAssessments, type WebsiteAnalysisDependencies } from "./website_ai";
import type { WebsiteNavigationHop } from "./website_types";

useTemporaryDatabase();

const NETFLIX_TEXT = "Netflix\nSign In\nEmail or phone number\nPassword\nSign In";
const NETFLIX_HTML = '<html><head><title>Netflix</title></head><body><h1>Sign In</h1><input type="text" id="iduserLoginId" aria-label="Email or phone number"><input type="password" id="idpassword" aria-label="Password"><button>Sign In</button></body></html>';
const MHTML = Buffer.from("From: <Saved by Blink>\r\nContent-Type: text/html\r\n\r\n<html><body>Netflix</body></html>", "utf8");
const PNG = Buffer.from("not-a-real-png");

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
	};
}

/** Streams the narrative, then the classification the production model returned for submission 373426928255766528. */
function phishingModel(): AnalysisClient {
	const outputs = [
		"The captured page impersonates Netflix and asks for an email and password.",
		JSON.stringify({ finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Sign In Email or phone number Password", collectionFieldRefs: ["f1", "f2"] }),
	];
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
		// A handed-over capture is parsed from its MHTML; the fake returns the
		// same evidence with the provenance it was given.
		archiveWebsite: async (options) => {
			archiveCalls.push(options);
			if (!options.mhtmlSnapshot) return archive;
			const navigationHops = options.navigationHops!;
			return { ...archive, requestedUrl: options.url, url: options.archivedUrl!, hostname: new URL(options.archivedUrl!).hostname, navigationHops, screenshotPng: undefined };
		},
	};
}

async function websiteSubmission(id: bigint, url: string) {
	return SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url } }, dedupeKey: `website-${new URL(url).hostname}`, status: "running", source: url });
}

async function waitForStatus(id: bigint, statuses: string[]) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const submission = await SubmissionsEntity.get(id);
		if (submission && statuses.includes(submission.status)) return submission;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Submission ${id} did not reach ${statuses.join("/")}.`);
}

describe("website redirects", () => {
	test("an IP-hosted kit reached through a same-host http→https redirect is reported with both URLs", async () => {
		const httpUrl = "http://85.215.226.225/Netflix/Home/login.php";
		const httpsUrl = "https://85.215.226.225/Netflix/Home/login.php";
		const archive = archiveOf([hop(0, httpUrl, 307, httpsUrl), hop(1, httpsUrl, 200)]);
		const id = await websiteSubmission(373426928255766528n, httpUrl);

		await analyzeWebsite({ submissionId: id, url: httpUrl }, dependencies(archive));

		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("reported");
		expect(submission?.info).toBe(`Phishing confirmed at ${httpsUrl}; a report for it and the 1 redirecting URL on 85.215.226.225 was queued.`);
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
		const archive = archiveOf([
			hop(0, shortUrl, 301, kitStart),
			hop(1, kitStart, 302, kitPage),
			hop(2, kitPage, 200),
		]);
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
		expect(archiveCalls[1]).toMatchObject({ url: kitStart, archivedUrl: kitPage, mhtmlSnapshot: MHTML });
		expect((await ArtifactsEntity.listForSubmission(childId)).map((artifact) => artifact.name).sort()).toEqual(["website.mhtml", "website.png"]);

		const report = await AbuseRepository.getReportForSubmission(childId);
		const targets = await AbuseRepository.listTargets(report!.id);
		expect(targets.map(({ normalizedTarget, observedUrls }) => ({ normalizedTarget, observedUrls }))).toEqual([
			{ normalizedTarget: "login-netflix.example.com", observedUrls: [kitPage, kitStart] },
		]);
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

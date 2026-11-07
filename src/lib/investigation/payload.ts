import type { ReportableWebsiteFinding, WebsiteDataUpload } from "../website_types";

/** A command the page shows, as the investigation needs it: what to fetch and what runs it. */
export type InvestigationPasteCommand = {
	shown: string;
	payloadUrls: string[];
	interpreters: string[];
};

/**
 * A drive-by finding's exploit loader, as the investigation needs it: the
 * stages to fetch with the browser identity the loader was served to, and
 * where its code sends what it takes.
 */
export type InvestigationExploitLoader = {
	frameUrl: string;
	userAgent: string;
	stageUrls: string[];
	dataUploads: WebsiteDataUpload[];
};

/** The durable payload of one `investigate_report` job. */
export type InvestigationJobPayload = {
	submissionId: string;
	pageUrl: string;
	finding: ReportableWebsiteFinding;
	pasteCommands: InvestigationPasteCommand[];
	exploitLoader?: InvestigationExploitLoader;
};

const MAX_COMMANDS = 10;
const MAX_URLS_PER_COMMAND = 5;
const MAX_STAGE_URLS = 12;
const MAX_DATA_UPLOADS = 8;

function readExploitLoader(value: unknown): InvestigationExploitLoader | undefined {
	if (!value || typeof value !== "object") return undefined;
	const loader = value as Record<string, unknown>;
	const stageUrls = stringArray(loader.stageUrls, MAX_STAGE_URLS);
	if (typeof loader.frameUrl !== "string" || typeof loader.userAgent !== "string" || !stageUrls || !Array.isArray(loader.dataUploads)) {
		throw new Error("Investigation job has a malformed payload.exploitLoader.");
	}
	const dataUploads = loader.dataUploads.slice(0, MAX_DATA_UPLOADS).flatMap((upload): WebsiteDataUpload[] => {
		const record = upload && typeof upload === "object" ? upload as Record<string, unknown> : {};
		const data = stringArray(record.data, 20);
		return typeof record.url === "string" && data && typeof record.observed === "boolean" ? [{ url: record.url, data, observed: record.observed }] : [];
	});
	return { frameUrl: loader.frameUrl, userAgent: loader.userAgent, stageUrls, dataUploads };
}

function stringArray(value: unknown, maximum: number): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
	return value.slice(0, maximum);
}

/** Read a stored job payload; a malformed one is a programming error, not a site verdict. */
export function readInvestigationJobPayload(value: unknown): InvestigationJobPayload {
	const payload = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const finding = payload.finding && typeof payload.finding === "object" ? payload.finding as Record<string, unknown> : {};
	if (typeof payload.submissionId !== "string" || !/^\d{1,20}$/.test(payload.submissionId)) throw new Error("Investigation job is missing payload.submissionId.");
	if (typeof payload.pageUrl !== "string" || !payload.pageUrl) throw new Error("Investigation job is missing payload.pageUrl.");
	let reportable: ReportableWebsiteFinding;
	if (finding.finding === "malware") reportable = { finding: "malware" };
	else if (finding.finding === "phishing" && (finding.phishingBasis === "credential_theft" || finding.phishingBasis === "payment_fraud")) {
		reportable = { finding: "phishing", phishingBasis: finding.phishingBasis };
	} else throw new Error("Investigation job is missing a valid payload.finding.");
	const commands = Array.isArray(payload.pasteCommands) ? payload.pasteCommands.slice(0, MAX_COMMANDS) : [];
	const pasteCommands = commands.flatMap((command): InvestigationPasteCommand[] => {
		const record = command && typeof command === "object" ? command as Record<string, unknown> : {};
		const payloadUrls = stringArray(record.payloadUrls, MAX_URLS_PER_COMMAND);
		const interpreters = stringArray(record.interpreters, 20);
		return typeof record.shown === "string" && payloadUrls && interpreters ? [{ shown: record.shown, payloadUrls, interpreters }] : [];
	});
	const exploitLoader = readExploitLoader(payload.exploitLoader);
	return { submissionId: payload.submissionId, pageUrl: payload.pageUrl, finding: reportable, pasteCommands, ...(exploitLoader ? { exploitLoader } : {}) };
}

import { AbuseRepository } from "../../repository";
import { routeContext } from "../../worker/shared";
import { asRecord } from "../../../values";
import { providerDefinitionMatchesPin } from "../definition";
import { providerEvidenceImageArtifactMatches } from "../evidence_image";
import {
	ProviderSubmissionNeedsHumanError,
	type ProviderCorrespondence,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionPreparation,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { withAlibabaConsole, type AlibabaConsole, type AlibabaConsoleDependencies } from "./api";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import {
	ALIBABA_CLOUD_EVIDENCE_CONTRACT,
	alibabaCloudSubmitParams,
	buildAlibabaCloudSubmissionPayload,
	selectAlibabaCloudScreenshot,
	storedAlibabaCloudSubmissionPayload,
	type AlibabaCloudSubmissionPayload,
} from "./payload";
import { alibabaCloudLoginConfig } from "./session";

type EvidenceFile = { fileName: string; filePath: string };

const { pageType, consoleOrigin } = ALIBABA_CLOUD_PROVIDER;
/** The account's report list, where a filed report shows up. */
const REPORT_RECORDS_URL = `${consoleOrigin}/#/reportRecord/${pageType}`;

function reportInput(report: { description: string; allegationCategory: string; legalBrandUrl: string | null }, target: { normalizedTarget: string; observedUrls: string[] }) {
	return {
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		description: report.description,
		allegationCategory: report.allegationCategory,
		legalBrandUrl: report.legalBrandUrl,
	};
}

function routeIsOurs(route: { routeType: string; providerRegistryKey: string; providerDefinitionVersion: string | null; providerDefinitionHash: string | null }): boolean {
	return route.routeType === "provider_submission" && route.providerRegistryKey === ALIBABA_CLOUD_PROVIDER.key
		&& providerDefinitionMatchesPin(ALIBABA_CLOUD_PROVIDER, route.providerDefinitionVersion, route.providerDefinitionHash);
}

/** Check the route and build the durable draft before any provider call. */
export async function prepareAlibabaCloudSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const { route, report, target, evidenceArtifacts } = await routeContext(context.routeId);
	if (!routeIsOurs(route)) return { outcome: "insufficient_evidence", reason: "alibaba_cloud_provider_definition_pin_mismatch" };
	if (target.targetType !== "domain" && target.targetType !== "ip") return { outcome: "insufficient_evidence", reason: "alibaba_cloud_requires_a_web_target" };
	const screenshot = selectAlibabaCloudScreenshot(evidenceArtifacts);
	if (!screenshot) return { outcome: "insufficient_evidence", reason: "alibaba_cloud_requires_a_screenshot" };
	// The account credentials are runtime secrets: validate them, never store them in the draft.
	alibabaCloudLoginConfig();
	const payload = buildAlibabaCloudSubmissionPayload({ ...reportInput(report, target), screenshot });
	if (!payload) return { outcome: "insufficient_evidence", reason: "alibaba_cloud_report_payload_invalid" };
	return { outcome: "ready", payload };
}

/** The stored draft, checked against its route and rebuilt from the current report. */
async function verifiedDraft(context: ProviderSubmissionContext): Promise<{ payload: AlibabaCloudSubmissionPayload; screenshot: Buffer }> {
	const payload = storedAlibabaCloudSubmissionPayload(context.payload);
	if (!payload) throw new Error("The persisted Alibaba Cloud submission payload is malformed.");
	const { route, report, target } = await routeContext(context.routeId);
	if (!routeIsOurs(route) || target.normalizedTarget !== payload.target.normalizedTarget) {
		throw new Error("The persisted Alibaba Cloud payload no longer matches its route.");
	}
	const expected = buildAlibabaCloudSubmissionPayload({ ...reportInput(report, target), screenshot: payload.screenshot });
	if (!expected || JSON.stringify(expected) !== JSON.stringify(payload)) {
		throw new Error("The persisted Alibaba Cloud payload no longer matches the report evidence.");
	}
	const artifact = await AbuseRepository.getArtifact(report.id, BigInt(payload.screenshot.artifactId));
	if (!artifact || !providerEvidenceImageArtifactMatches(payload.screenshot, artifact, ALIBABA_CLOUD_EVIDENCE_CONTRACT)) {
		throw new Error("The persisted Alibaba Cloud screenshot no longer matches its immutable reference.");
	}
	return { payload, screenshot: artifact.blob };
}

export type AlibabaCloudSubmissionDependencies = AlibabaConsoleDependencies;

/**
 * Get a session and upload the screenshot before the durable marker. Neither
 * files a report: an upload only stores a file the report can then name.
 */
export async function prepareAlibabaCloudExternalSubmission(
	context: ProviderSubmissionContext,
	dependencies: AlibabaCloudSubmissionDependencies = {},
): Promise<ProviderSubmissionPreflight> {
	const { payload, screenshot } = await verifiedDraft(context);
	const evidenceFile = await withAlibabaConsole(async (console) => {
		// The international console files reports only for an international (sg) account.
		const area = asRecord(await console.call("GetUserIdArea"));
		if (area?.Env !== "sg") throw new ProviderSubmissionNeedsHumanError(`The Alibaba Cloud reporting account is not an international (sg) account (Env ${String(area?.Env)}).`);
		const fileName = payload.screenshot.filename;
		return { fileName, filePath: await console.upload({ name: fileName, mimeType: payload.screenshot.mimeType, bytes: screenshot }) } satisfies EvidenceFile;
	}, { ...dependencies, ...(context.signal ? { signal: context.signal } : {}) });
	return { state: evidenceFile };
}

function storedEvidenceFile(state: unknown): EvidenceFile | undefined {
	const record = asRecord(state);
	return record && typeof record.fileName === "string" && typeof record.filePath === "string" ? { fileName: record.fileName, filePath: record.filePath } : undefined;
}

/** One entry of the account's report list. */
export type AlibabaReportRecord = { reportTaskId: string; existCrossRegion: boolean; reportDomainIp?: string; status?: string; createdAt?: number };

function recordTime(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value) {
		const time = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
		return Number.isFinite(time) ? time : undefined;
	}
	return undefined;
}

/** Read `ReportTaskList`'s `List` defensively: only entries with a task ID count. */
export function parseAlibabaReportRecords(data: unknown): AlibabaReportRecord[] {
	const list = asRecord(data)?.List;
	if (!Array.isArray(list)) return [];
	return list.flatMap((value) => {
		const item = asRecord(value);
		const id = item?.ReportTaskId;
		if (!item || (typeof id !== "string" && typeof id !== "number") || String(id).length === 0) return [];
		const domainIp = item.ReportDomainIp ?? item.ReportObject;
		const status = item.ReportStatus ?? item.Status;
		const created = recordTime(item.GmtCreate ?? item.CreateTime ?? item.ReportTime);
		return [{
			reportTaskId: String(id),
			existCrossRegion: item.ExistCrossRegion === true,
			...(typeof domainIp === "string" ? { reportDomainIp: domainIp } : {}),
			...(typeof status === "string" ? { status } : {}),
			...(created !== undefined ? { createdAt: created } : {}),
		}];
	});
}

/** The newest listed report for this draft's object, filed no earlier than `since`. */
async function findRecord(console: AlibabaConsole, payload: AlibabaCloudSubmissionPayload, since: Date): Promise<AlibabaReportRecord | undefined> {
	const records = parseAlibabaReportRecords(await console.call("ReportTaskList", { pageType, page: 1, pageSize: 20 }));
	return records
		.filter((record) => record.reportDomainIp === payload.report.reportDomainIp && (record.createdAt === undefined || record.createdAt >= since.getTime() - 5 * 60_000))
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

/** The receipt ID: the report's task ID, with `@cn` when Alibaba moved it to the China site's review. */
function confirmationIdOf(record: AlibabaReportRecord): string {
	return record.existCrossRegion ? `${record.reportTaskId}@cn` : record.reportTaskId;
}

/** File the report from its durable draft and the uploaded screenshot. */
export async function submitAlibabaCloudSubmission(
	context: ProviderSubmissionContext,
	preflight: ProviderSubmissionPreflight | undefined,
	dependencies: AlibabaCloudSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const sentAt = new Date();
	const options = { ...dependencies, ...(context.signal ? { signal: context.signal } : {}) };
	const evidenceFile = storedEvidenceFile(preflight?.state) ?? storedEvidenceFile((await prepareAlibabaCloudExternalSubmission(context, dependencies)).state);
	const { payload } = await verifiedDraft(context);
	const answer = await withAlibabaConsole(async (console) => {
		// The form asks this first: a resource of a China-site customer is
		// reviewed there, which needs the reporter's consent to transfer it.
		const crossRegion = await console.call("GetCrossRegionExist", { reportDomainIp: payload.report.reportDomainIp, pageType });
		return console.call("SubmitReportTask", alibabaCloudSubmitParams(payload, evidenceFile!, crossRegion === true));
	}, options);
	// The report is filed. Its task ID comes from the report list; a failed
	// lookup leaves the success without one rather than risking a resubmission.
	const record = await withAlibabaConsole((console) => findRecord(console, payload, sentAt), options).catch(() => undefined);
	const answered = typeof answer === "string" || typeof answer === "number" ? String(answer) : undefined;
	const confirmationId = record ? confirmationIdOf(record) : answered;
	return {
		...(confirmationId ? { confirmationId } : {}),
		confirmationText: record?.status ? `Alibaba Cloud filed the report (${record.status}).` : "Alibaba Cloud accepted the report.",
		finalUrl: REPORT_RECORDS_URL,
		submittedTargets: [payload.target.normalizedTarget],
	};
}

/** Find a report whose submission answer was lost, in the account's report list. */
export async function findAlibabaCloudSubmission(
	context: ProviderSubmissionContext & { sentAt: Date },
	dependencies: AlibabaCloudSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess | undefined> {
	const payload = storedAlibabaCloudSubmissionPayload(context.payload);
	if (!payload) return undefined;
	const record = await withAlibabaConsole((console) => findRecord(console, payload, context.sentAt), { ...dependencies, ...(context.signal ? { signal: context.signal } : {}) });
	if (!record) return undefined;
	return {
		confirmationId: confirmationIdOf(record),
		confirmationText: `Alibaba Cloud lists the report${record.status ? ` (${record.status})` : ""}.`,
		finalUrl: REPORT_RECORDS_URL,
		submittedTargets: [payload.target.normalizedTarget],
	};
}

/** Review states after which Alibaba does nothing more with a report. */
const FINAL_STATES = new Set(["Completed", "Invalid", "Revoked", "Abnormal", "Withdrawal"]);

/** Read `GetReportStatus`'s steps: each is one state the report reached, with Alibaba's note. */
export function parseAlibabaReportStatus(reportTaskId: string, data: unknown): ProviderCorrespondence {
	const list = asRecord(data)?.ReportStatusList;
	const steps = (Array.isArray(list) ? list : []).flatMap((value, index) => {
		const step = asRecord(value);
		const state = step?.ReportStatus;
		if (!step || typeof state !== "string" || !state) return [];
		const at = recordTime(step.GmtCreate ?? step.Time ?? step.ProcessTime ?? step.GmtModified);
		const notes = [step.Remark, step.Reason, step.Description, step.Result, step.ReplyContent]
			.filter((note): note is string => typeof note === "string" && note.trim().length > 0)
			.map((note) => note.trim());
		return [{ index, state, at, notes }];
	});
	const last = steps.at(-1);
	return {
		messages: steps.filter((step) => step.at !== undefined).map((step) => ({
			id: `${reportTaskId}:${step.index}:${step.state}`,
			subject: `Alibaba Cloud report ${reportTaskId}: ${step.state}`,
			body: [step.state, ...step.notes].join("\n\n"),
			sentAt: new Date(step.at!),
		})),
		...(last ? { status: { state: last.state, ...(last.notes.length ? { detail: last.notes.join(" ") } : {}) }, final: FINAL_STATES.has(last.state) } : {}),
	};
}

/** Read a filed report's review progress from the console. */
export async function fetchAlibabaCloudCorrespondence(
	context: { confirmationId: string; signal?: AbortSignal },
	dependencies: AlibabaCloudSubmissionDependencies = {},
): Promise<ProviderCorrespondence> {
	const [reportTaskId, region] = context.confirmationId.split("@");
	if (!reportTaskId) throw new Error("The Alibaba Cloud receipt ID is empty.");
	const data = await withAlibabaConsole((console) => console.call("GetReportStatus", { reportTaskId, existCrossRegion: region === "cn", pageType }), {
		...dependencies,
		...(context.signal ? { signal: context.signal } : {}),
	});
	return parseAlibabaReportStatus(reportTaskId, data);
}

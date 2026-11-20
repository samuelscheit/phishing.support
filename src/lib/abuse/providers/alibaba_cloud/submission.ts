import { asRecord } from "../../../util/values";
import { createDraft } from "../kit/draft";
import { evidenceReferenceOf, loadEvidenceFile } from "../kit/evidence";
import {
	ProviderSubmissionNeedsHumanError,
	type ProviderCorrespondence,
	type ProviderSubmissionContext,
	type ProviderSubmissionPreflight,
	type ProviderSubmissionSuccess,
} from "../submission_contracts";
import { withAlibabaConsole, type AlibabaConsole, type AlibabaConsoleDependencies as AlibabaCloudSubmissionDependencies } from "./api";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import {
	ALIBABA_CLOUD_EVIDENCE_CONTRACT,
	alibabaCloudSubmitParams,
	buildAlibabaCloudSubmissionPayload,
	storedAlibabaCloudSubmissionPayload,
	type AlibabaCloudSubmissionPayload,
} from "./payload";
import { alibabaCloudLoginConfig, type AlibabaCloudSession } from "./session";

type EvidenceFile = { fileName: string; filePath: string };

/** Everything the one post-marker request needs, prepared and verified before the marker. Held in memory only. */
type AlibabaPreflight = {
	payload: AlibabaCloudSubmissionPayload;
	evidenceFile: EvidenceFile;
	session: AlibabaCloudSession;
	/** The account's listed task IDs right before filing: the receipt is the new one. */
	listedTaskIds: string[];
};

const { pageType, consoleOrigin } = ALIBABA_CLOUD_PROVIDER;
/** The account's report list, where a filed report shows up. */
const REPORT_RECORDS_URL = `${consoleOrigin}/#/reportRecord/${pageType}`;

export const alibabaCloudDraft = createDraft({
	definition: ALIBABA_CLOUD_PROVIDER,
	reasonPrefix: "alibaba_cloud",
	targetTypes: ["domain", "ip"],
	targetReason: "alibaba_cloud_requires_a_web_target",
	read: storedAlibabaCloudSubmissionPayload,
	input: ({ report, target, evidenceArtifacts }, stored: AlibabaCloudSubmissionPayload | undefined) => {
		const screenshot = evidenceReferenceOf(ALIBABA_CLOUD_EVIDENCE_CONTRACT, evidenceArtifacts, stored && { evidence: stored.screenshot });
		// The account credentials are runtime secrets: validate them, never store them in the draft.
		// The mailboxes now belong to this form, so without an account the report waits for a person.
		if (!stored && screenshot) {
			try {
				alibabaCloudLoginConfig();
			} catch (error) {
				throw new ProviderSubmissionNeedsHumanError(error instanceof Error ? error.message : String(error));
			}
		}
		return {
			target: target.normalizedTarget,
			observedUrls: target.observedUrls,
			description: report.description,
			allegationCategory: report.allegationCategory,
			legalBrandUrl: report.legalBrandUrl,
			screenshot,
		};
	},
	admit: (_data, input) => input.screenshot ? undefined : "alibaba_cloud_requires_a_screenshot",
	build: buildAlibabaCloudSubmissionPayload,
	targetOf: (payload) => payload.target.normalizedTarget,
});

/** Check the route and build the durable draft before any provider call. */
export const prepareAlibabaCloudSubmission = alibabaCloudDraft.prepare;

/** The stored draft, checked against its route and rebuilt from the current report; with its screenshot's bytes. */
async function verifiedDraft(context: ProviderSubmissionContext) {
	const { payload, data } = await alibabaCloudDraft.verify(context);
	const { bytes } = await loadEvidenceFile({ reference: payload.screenshot, contract: ALIBABA_CLOUD_EVIDENCE_CONTRACT, reportId: data.report.id, label: "Alibaba Cloud screenshot" });
	return { payload, screenshot: bytes };
}

export type { AlibabaCloudSubmissionDependencies };

/**
 * Verify the draft, get a session and upload the screenshot, all before the
 * durable marker. None of it files a report: an upload only stores a file the
 * report can then name.
 */
export async function prepareAlibabaCloudExternalSubmission(
	context: ProviderSubmissionContext,
	dependencies: AlibabaCloudSubmissionDependencies = {},
): Promise<ProviderSubmissionPreflight> {
	const { payload, screenshot } = await verifiedDraft(context);
	const state = await withAlibabaConsole(async (console, session): Promise<AlibabaPreflight> => {
		// The international console files reports only for an international (sg) account.
		const env = asRecord(await console.call("GetUserIdArea"))?.Env;
		if (typeof env !== "string" || !env) throw new Error("Alibaba Cloud GetUserIdArea named no account region.");
		if (env !== "sg") throw new ProviderSubmissionNeedsHumanError(`The Alibaba Cloud reporting account is not an international (sg) account (Env ${env}).`);
		const fileName = payload.screenshot.filename;
		const filePath = await console.upload({ name: fileName, mimeType: payload.screenshot.mimeType, bytes: screenshot });
		const listedTaskIds = (await listRecords(console)).map((record) => record.reportTaskId);
		return { payload, evidenceFile: { fileName, filePath }, session, listedTaskIds };
	}, { ...dependencies, ...(context.signal ? { signal: context.signal } : {}) });
	return { state };
}

function preflightState(preflight: ProviderSubmissionPreflight): AlibabaPreflight {
	const state = preflight.state as Partial<AlibabaPreflight> | undefined;
	if (!state?.payload || !state.evidenceFile || !state.session || !state.listedTaskIds) throw new Error("The Alibaba Cloud submission has no prepared state.");
	return state as AlibabaPreflight;
}

/** A task ID as the console names reports; anything else is not a receipt. */
const REPORT_TASK_ID = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * The console names a report's state in Chinese whatever the account's
 * language; these are its own English names for them (its translation table,
 * `infr.reportRecord.enum.*`), which `reviewVerdicts` maps.
 */
const REPORT_STATES: Readonly<Record<string, string>> = {
	已创建: "Created",
	待认领: "Assigning",
	处理中: "Processing",
	// Not in the console's table; seen on 2026-11-20 right after filing.
	自动化审理中: "Automated review",
	补充资料: "Supplementary information",
	暂不处理: "Abnormal",
	已完结: "Completed",
	举报成立: "Valid",
	已撤诉: "Withdrawal",
	已撤销: "Revoked",
	通知整改: "Notify rectification",
	举报不成立: "Invalid",
};

function reportState(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	return REPORT_STATES[value.trim()] ?? value.trim();
}

/** One entry of the account's report list. */
export type AlibabaReportRecord = { reportTaskId: string; existCrossRegion: boolean; reportDomainIp?: string; status?: string; createdAt?: number };

/**
 * A console time: epoch seconds or milliseconds, or a date string. A string
 * without a zone ("2026-11-20 18:07:56") is Alibaba's console time, UTC+8.
 */
export function recordTime(value: unknown): number | undefined {
	const epoch = typeof value === "number" ? value : typeof value === "string" && /^\d{10}(?:\d{3})?$/.test(value) ? Number(value) : undefined;
	if (epoch !== undefined) return Number.isFinite(epoch) && epoch > 0 ? (epoch < 1e11 ? epoch * 1000 : epoch) : undefined;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const text = value.trim().replace(" ", "T");
	const time = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}+08:00`);
	return Number.isFinite(time) ? time : undefined;
}

/** Read `ReportTaskList`'s `List` defensively: only entries with a task ID count. */
export function parseAlibabaReportRecords(data: unknown): AlibabaReportRecord[] {
	const list = asRecord(data)?.List;
	if (!Array.isArray(list)) return [];
	return list.flatMap((value) => {
		const item = asRecord(value);
		const id = item?.ReportTaskId;
		if (!item || (typeof id !== "string" && typeof id !== "number") || String(id).length === 0) return [];
		const domainIp = item.ReportDomainIp;
		// 2026-11-20: {ExistCrossRegion, TypeReport, ErrorStatus, GmtCreated:"2026-11-20 18:24:26", ReportStatus:"已创建", ReportTaskId, ReportDomainIp}
		const status = reportState(item.ReportStatus);
		const created = recordTime(item.GmtCreated);
		return [{
			reportTaskId: String(id),
			existCrossRegion: item.ExistCrossRegion === true,
			...(typeof domainIp === "string" ? { reportDomainIp: domainIp } : {}),
			...(status ? { status } : {}),
			...(created !== undefined ? { createdAt: created } : {}),
		}];
	});
}

async function listRecords(console: AlibabaConsole): Promise<AlibabaReportRecord[]> {
	return parseAlibabaReportRecords(await console.call("ReportTaskList", { pageType, page: 1, pageSize: 20 }));
}

/**
 * The report this filing created: a listed task for the same object that was
 * not listed right before it. When the answer was lost there is no such list,
 * so only a report whose own time says it was filed since then counts.
 */
function matchRecord(records: readonly AlibabaReportRecord[], payload: AlibabaCloudSubmissionPayload, filed: { before: readonly string[] } | { since: Date }): AlibabaReportRecord | undefined {
	return records
		.filter((record) => record.reportDomainIp === payload.report.reportDomainIp)
		.filter((record) => "before" in filed
			? !filed.before.includes(record.reportTaskId)
			: record.createdAt !== undefined && record.createdAt >= filed.since.getTime() - 60_000)
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
}

/** The receipt ID: the report's task ID, with `@cn` when Alibaba moved it to the China site's review. */
function confirmationIdOf(record: AlibabaReportRecord): string {
	return record.existCrossRegion ? `${record.reportTaskId}@cn` : record.reportTaskId;
}

/** File the report from the prepared draft and uploaded screenshot: the only work after the durable marker. */
export async function submitAlibabaCloudSubmission(
	context: ProviderSubmissionContext,
	preflight: ProviderSubmissionPreflight,
	dependencies: AlibabaCloudSubmissionDependencies = {},
): Promise<ProviderSubmissionSuccess> {
	const { payload, evidenceFile, session, listedTaskIds } = preflightState(preflight);
	const options = { ...dependencies, session, ...(context.signal ? { signal: context.signal } : {}) };
	const answer = await withAlibabaConsole(async (console) => {
		// The form asks this first: a resource of a China-site customer is
		// reviewed there, which needs the reporter's consent to transfer it.
		const crossRegion = await console.call("GetCrossRegionExist", { reportDomainIp: payload.report.reportDomainIp, pageType });
		return console.call("SubmitReportTask", alibabaCloudSubmitParams(payload, evidenceFile, crossRegion === true));
	}, options);
	// The report is filed. Its task ID comes from the report list; a failed
	// lookup leaves the success without one rather than risking a resubmission.
	const record = await withAlibabaConsole(async (console) => matchRecord(await listRecords(console), payload, { before: listedTaskIds }), { ...dependencies, ...(context.signal ? { signal: context.signal } : {}) }).catch(() => undefined);
	const answered = (typeof answer === "string" || typeof answer === "number") && REPORT_TASK_ID.test(String(answer)) ? String(answer) : undefined;
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
	const record = await withAlibabaConsole(async (console) => matchRecord(await listRecords(console), payload, { since: context.sentAt }), { ...dependencies, ...(context.signal ? { signal: context.signal } : {}) });
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
	const listed = (Array.isArray(list) ? list : []).flatMap((value) => {
		// 2026-11-20: {CreateTime:"2026-11-20 18:25:03", ReportStatus:"处理中"}, oldest first.
		const step = asRecord(value);
		const state = reportState(step?.ReportStatus);
		if (!step || !state) return [];
		const at = recordTime(step.CreateTime);
		const notes = [step.Remark, step.Reason, step.Description, step.Result, step.ReplyContent]
			.filter((note): note is string => typeof note === "string" && note.trim().length > 0)
			.map((note) => note.trim());
		return [{ state, at, notes }];
	});
	// Oldest first whatever order the console lists them in, when every step has a time.
	const steps = listed.every((step) => step.at !== undefined) ? [...listed].sort((a, b) => a.at! - b.at!) : listed;
	const last = steps.at(-1);
	return {
		messages: steps.filter((step) => step.at !== undefined).map((step) => ({
			id: `${reportTaskId}:${step.state}:${step.at}`,
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

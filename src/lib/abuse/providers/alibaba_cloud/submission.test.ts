import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { contactRoute } from "../../resolver/routes";
import { abuseArtifacts, abuseProviderRoutes, abuseTargets } from "../../schema";
import { executeProviderSubmission } from "../submission_execution";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError, type ProviderSubmissionProvider } from "../submission_contracts";
import { AlibabaConsoleError } from "./api";
import { alibabaCloudProvider } from "./index";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import { alibabaCloudSubmitParams, storedAlibabaCloudSubmissionPayload } from "./payload";
import {
	fetchAlibabaCloudCorrespondence,
	findAlibabaCloudSubmission,
	parseAlibabaReportRecords,
	parseAlibabaReportStatus,
	prepareAlibabaCloudExternalSubmission,
	prepareAlibabaCloudSubmission,
	submitAlibabaCloudSubmission,
} from "./submission";
import { consoleRefusal, consoleSuccess, fakeConsoleFetch, freshSession, loginConfig, NEED_LOGIN, session, SUCCESS_ENV_SG, UPLOAD_POLICY } from "./test_support";

useTemporaryDatabase();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("alibaba-screenshot")]);
const TARGET = "login-example-phish.com";
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";
const MAILBOXES = ["domainabuse@service.aliyun.com", "infosec@service.aliyun.com", "abuse@alibaba-inc.com"];

const envNames = ["ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL", "ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD"] as const;
let savedEnvironment: Array<string | undefined>;
beforeEach(() => {
	savedEnvironment = envNames.map((name) => process.env[name]);
	process.env.ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL = loginConfig.email;
	process.env.ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD = loginConfig.password;
});
afterEach(() => {
	envNames.forEach((name, index) => {
		if (savedEnvironment[index] === undefined) delete process.env[name];
		else process.env[name] = savedEnvironment[index];
	});
});

async function alibabaRoute(options: { target?: string; allegationCategory?: "phishing" | "malware"; screenshot?: boolean; mailbox?: string; observedUrls?: string[]; legalBrandUrl?: string } = {}) {
	const target = options.target ?? TARGET;
	const request = await validateAbuseReportRequest({
		targets: [target],
		allegationCategory: options.allegationCategory ?? "phishing",
		description,
		observedUrls: [{ target, urls: options.observedUrls ?? [`https://${target}/signin`] }],
		legalBrandUrl: options.legalBrandUrl ?? "https://www.examplebank.com/",
	});
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [stored] = await AbuseRepository.listTargets(created.reportId);
	if (options.screenshot !== false) await AbuseRepository.saveArtifact({ reportId: created.reportId, name: "website.png", kind: "user_evidence_original", mimeType: "image/png", buffer: PNG });
	const route = await AbuseRepository.upsertResolvedRoute(stored!.id, contactRoute({ email: options.mailbox ?? MAILBOXES[0]!, providerName: "Alibaba", provenance: {}, snapshot: {} }));
	return { created, route, targetId: stored!.id };
}

async function readyContext(options: Parameters<typeof alibabaRoute>[0] = {}) {
	const fixture = await alibabaRoute(options);
	const preparation = await prepareAlibabaCloudSubmission({ routeId: fixture.route.id, payload: {} });
	if (preparation.outcome !== "ready") throw new Error(`expected ready, got ${JSON.stringify(preparation)}`);
	const payload = storedAlibabaCloudSubmissionPayload(preparation.payload);
	if (!payload) throw new Error("expected a stored payload");
	return { ...fixture, payload, context: { routeId: fixture.route.id, payload: payload as unknown as Record<string, unknown> } };
}

/** The console as it answered on 2026-11-20 for a fresh account. */
function consoleAnswers(overrides: Parameters<typeof fakeConsoleFetch>[0] = {}) {
	return fakeConsoleFetch({
		GetUserIdArea: SUCCESS_ENV_SG,
		UploadFileByName: consoleSuccess(UPLOAD_POLICY),
		GetCrossRegionExist: consoleSuccess(false),
		SubmitReportTask: consoleSuccess({ Env: "sg" }),
		ReportTaskList: consoleSuccess({ PageSize: 20, Total: 0, List: [], Page: 1 }),
		...overrides,
	});
}
const dependencies = (console: { fetch: never }) => ({ fetch: console.fetch, config: loginConfig, getSession: async () => session });

describe("registry", () => {
	test("all three mailboxes resolve to the alibaba_cloud provider, and nothing else claims them", async () => {
		const { getProviderSubmissionProviderForMailbox, listProviderSubmissionProviders } = await import("../submission_registry_default");
		for (const mailbox of MAILBOXES) {
			expect(getProviderSubmissionProviderForMailbox(mailbox)?.definition.key).toBe("alibaba_cloud");
			expect(getProviderSubmissionProviderForMailbox(` ${mailbox.toUpperCase()} `)?.definition.key).toBe("alibaba_cloud");
			expect(contactRoute({ email: mailbox, providerName: "Alibaba", provenance: {}, snapshot: {} })).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "alibaba_cloud", verifiedEmail: mailbox });
		}
		const owners = listProviderSubmissionProviders().filter((provider) => provider.definition.exactMailboxes.some((mailbox) => MAILBOXES.includes(mailbox.toLowerCase())));
		expect(owners.map((provider) => provider.definition.key)).toEqual(["alibaba_cloud"]);
		// Neighbouring mailboxes stay plain email routes.
		for (const mailbox of ["abuse@service.aliyun.com", "domainabuse@aliyun.com", "abuse@alibabacloud.com", "infosec@sub.service.aliyun.com"]) {
			expect(getProviderSubmissionProviderForMailbox(mailbox)).toBeUndefined();
			expect(contactRoute({ email: mailbox, providerName: "Alibaba", provenance: {}, snapshot: {} }).routeType).toBe("email");
		}
	});

	test("the provider wires every handler and review verdicts for Alibaba's review states", () => {
		expect(alibabaCloudProvider.definition).toBe(ALIBABA_CLOUD_PROVIDER);
		for (const handler of ["prepareSubmission", "prepareExternalSubmission", "submit", "submitPrepared", "findSubmission", "fetchCorrespondence", "buildReportPreview"] as const) expect(typeof alibabaCloudProvider[handler]).toBe("function");
		expect(alibabaCloudProvider.reviewVerdicts).toEqual({
			Valid: "acknowledged",
			"Notify rectification": "acknowledged",
			Completed: "acknowledged",
			"Supplementary information": "needs_more_information",
			Invalid: "rejected",
			Abnormal: "rejected",
		});
	});

	test("an older draft is refreshed; a current one is not", async () => {
		const { payload } = await readyContext();
		const refresh = (candidate: Record<string, unknown>) => alibabaCloudProvider.shouldRefreshStartingPayload!({ routeId: 1n, payload: candidate } as never);
		expect(refresh(payload as unknown as Record<string, unknown>)).toBeFalse();
		expect(refresh({ ...payload, adapter: "alibaba_cloud_report_v0" })).toBeTrue();
		expect(refresh({ ...payload, providerNarrativeVersion: 2 })).toBeTrue();
	});

	test("the preview is the reason the draft stores", async () => {
		const { payload } = await readyContext();
		expect(alibabaCloudProvider.buildReportPreview!({ target: TARGET, observedUrls: [`https://${TARGET}/signin`], description, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/" })).toBe(payload.report.reportReason);
	});
});

describe("prepareAlibabaCloudSubmission", () => {
	test("drafts a ready, secret-free payload from the route's report", async () => {
		const { payload } = await readyContext();
		expect(storedAlibabaCloudSubmissionPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
		expect(payload).toMatchObject({ target: { normalizedTarget: TARGET }, report: { typeReport: "Phishing Scams", reportDomainIp: `https://${TARGET}/signin`, impactItem: "https://www.examplebank.com/" } });
		expect(JSON.stringify(payload)).not.toContain(loginConfig.password);
	});

	test("an IP target and a malware report are drafted too", async () => {
		const ip = await readyContext({ target: "34.102.117.75", observedUrls: ["https://34.102.117.75/login"], allegationCategory: "malware" });
		expect(ip.payload.report).toMatchObject({ typeReport: "Illegal Activities", reportDomainIp: "https://34.102.117.75/login" });
	});

	test("a pin mismatch, a non-web target and a missing screenshot all end the route as insufficient evidence", async () => {
		const mismatch = await alibabaRoute();
		(await getDb()).update(abuseProviderRoutes).set({ providerDefinitionHash: "0".repeat(64) }).where(eq(abuseProviderRoutes.id, mismatch.route.id)).run();
		expect(await prepareAlibabaCloudSubmission({ routeId: mismatch.route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: "alibaba_cloud_provider_definition_pin_mismatch" });

		const wrongVersion = await alibabaRoute();
		(await getDb()).update(abuseProviderRoutes).set({ providerDefinitionVersion: "1999-01-01" }).where(eq(abuseProviderRoutes.id, wrongVersion.route.id)).run();
		expect(await prepareAlibabaCloudSubmission({ routeId: wrongVersion.route.id, payload: {} })).toMatchObject({ reason: "alibaba_cloud_provider_definition_pin_mismatch" });

		const otherProvider = await alibabaRoute();
		(await getDb()).update(abuseProviderRoutes).set({ providerRegistryKey: "gname" }).where(eq(abuseProviderRoutes.id, otherProvider.route.id)).run();
		expect(await prepareAlibabaCloudSubmission({ routeId: otherProvider.route.id, payload: {} })).toMatchObject({ reason: "alibaba_cloud_provider_definition_pin_mismatch" });

		const email = await alibabaRoute();
		(await getDb()).update(abuseTargets).set({ targetType: "email" }).where(eq(abuseTargets.id, email.targetId)).run();
		expect(await prepareAlibabaCloudSubmission({ routeId: email.route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: "alibaba_cloud_requires_a_web_target" });

		const bare = await alibabaRoute({ screenshot: false });
		expect(await prepareAlibabaCloudSubmission({ routeId: bare.route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: "alibaba_cloud_requires_a_screenshot" });
	});

	test("missing or malformed credentials fail the preparation (retryable) rather than drafting", async () => {
		const { route } = await alibabaRoute();
		delete process.env.ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL;
		await expect(prepareAlibabaCloudSubmission({ routeId: route.id, payload: {} })).rejects.toThrow("ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL");
		process.env.ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL = loginConfig.email;
		delete process.env.ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD;
		await expect(prepareAlibabaCloudSubmission({ routeId: route.id, payload: {} })).rejects.toThrow("ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD");
	});

	test("an unknown route fails", async () => {
		await expect(prepareAlibabaCloudSubmission({ routeId: 999_999n, payload: {} })).rejects.toThrow("no longer exists");
	});
});

describe("preflight: area check and evidence upload", () => {
	test("uploads the screenshot under its generated name and returns the stored file as state; nothing is filed", async () => {
		const { context, payload } = await readyContext();
		const console = consoleAnswers();
		const preflight = await prepareAlibabaCloudExternalSubmission(context, dependencies(console as never));
		expect(preflight).toEqual({ state: { fileName: payload.screenshot.filename, filePath: UPLOAD_POLICY.Key } });
		expect(console.actions()).toEqual(["GetUserIdArea", "UploadFileByName"]);
		expect(console.requests[1]!.params).toEqual({ name: payload.screenshot.filename });
		const sent = [...console.requests[2]!.form!.entries()].at(-1)![1] as unknown as File;
		expect(Buffer.from(await sent.arrayBuffer()).equals(PNG)).toBeTrue();
	});

	test("an account outside the international site needs a person, before any upload", async () => {
		const { context } = await readyContext();
		for (const env of ["cn", undefined]) {
			const console = consoleAnswers({ GetUserIdArea: consoleSuccess(env ? { Env: env } : null) });
			const failure = await prepareAlibabaCloudExternalSubmission(context, dependencies(console as never)).catch((error) => error);
			expect(failure).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
			expect(failure.message).toContain(`Env ${String(env)}`);
			expect(console.actions()).toEqual(["GetUserIdArea"]);
		}
	});

	test("a malformed, mismatched or tampered draft fails before any console call", async () => {
		const { context, payload, created } = await readyContext();
		const console = consoleAnswers();
		const run = (candidate: Record<string, unknown>, routeId = context.routeId) => prepareAlibabaCloudExternalSubmission({ routeId, payload: candidate }, dependencies(console as never));
		await expect(run({})).rejects.toThrow("malformed");
		await expect(run({ ...payload, report: { ...payload.report, reportReason: "Totally different reason" } })).rejects.toThrow("no longer matches the report evidence");
		await expect(run({ ...payload, report: { ...payload.report, impactItem: "https://other-bank.com/" } })).rejects.toThrow("no longer matches the report evidence");
		await expect(run({ ...payload, target: { normalizedTarget: "other-phish.com" } })).rejects.toThrow("no longer matches its route");
		await expect(run({ ...payload, definition: { ...payload.definition, contentHash: "1".repeat(64) } })).rejects.toThrow("malformed");
		await expect(run({ ...payload, screenshot: { ...payload.screenshot, artifactId: "99999", filename: `alibaba_cloud_report_99999_${payload.screenshot.sha256.slice(0, 12)}.png` } })).rejects.toThrow("no longer matches its immutable reference");
		const stale = await alibabaRoute({ target: "another-phish.com" });
		await expect(run(payload, stale.route.id)).rejects.toThrow("no longer matches its route");
		expect(created.reportId).toBeDefined();
		expect(console.requests).toHaveLength(0);
	});

	test("a pin mismatch on the route blocks the preflight", async () => {
		const { context, route } = await readyContext();
		(await getDb()).update(abuseProviderRoutes).set({ providerDefinitionHash: "0".repeat(64) }).where(eq(abuseProviderRoutes.id, route.id)).run();
		await expect(prepareAlibabaCloudExternalSubmission(context, dependencies(consoleAnswers() as never))).rejects.toThrow("no longer matches its route");
	});

	test("a screenshot whose stored bytes changed is refused before upload", async () => {
		const { context, created } = await readyContext();
		const tampered = Buffer.concat([PNG, Buffer.from("!")]);
		(await getDb()).update(abuseArtifacts).set({ blob: tampered }).where(eq(abuseArtifacts.reportId, created.reportId)).run();
		const console = consoleAnswers();
		await expect(prepareAlibabaCloudExternalSubmission(context, dependencies(console as never))).rejects.toThrow("no longer matches its immutable reference");
		expect(console.requests).toHaveLength(0);
	});
});

describe("submitAlibabaCloudSubmission", () => {
	test("files once with the browser's exact parameters and returns the receipt from the report list", async () => {
		const { context, payload } = await readyContext();
		const console = consoleAnswers({
			ReportTaskList: consoleSuccess({ PageSize: 20, Total: 1, Page: 1, List: [{ ReportTaskId: "RT-20261120-1", ReportDomainIp: payload.report.reportDomainIp, ReportStatus: "Valid", GmtCreate: Date.now(), ExistCrossRegion: false }] }),
		});
		const success = await submitAlibabaCloudSubmission(context, undefined, dependencies(console as never));
		expect(console.actions()).toEqual(["GetUserIdArea", "UploadFileByName", "GetCrossRegionExist", "SubmitReportTask", "ReportTaskList"]);
		expect(console.count("SubmitReportTask")).toBe(1);
		const evidence = { fileName: payload.screenshot.filename, filePath: UPLOAD_POLICY.Key };
		expect(console.requests.find((r) => r.action === "SubmitReportTask")!.params).toEqual(alibabaCloudSubmitParams(payload, evidence, false));
		expect(console.requests.find((r) => r.action === "GetCrossRegionExist")!.params).toEqual({ reportDomainIp: payload.report.reportDomainIp, pageType: "harmInfo" });
		expect(console.requests.find((r) => r.action === "ReportTaskList")!.params).toEqual({ pageType: "harmInfo", page: 1, pageSize: 20 });
		expect(success).toEqual({
			confirmationId: "RT-20261120-1",
			confirmationText: "Alibaba Cloud filed the report (Valid).",
			finalUrl: "https://report.alibabacloud.com/#/reportRecord/harmInfo",
			submittedTargets: [TARGET],
		});
	});

	test("a preflight's uploaded file is reused: no second area check or upload", async () => {
		const { context, payload } = await readyContext();
		const console = consoleAnswers();
		const preflight = { state: { fileName: payload.screenshot.filename, filePath: "report/earlier/key" } };
		await submitAlibabaCloudSubmission(context, preflight, dependencies(console as never));
		expect(console.actions()).toEqual(["GetCrossRegionExist", "SubmitReportTask", "ReportTaskList"]);
		expect((console.requests[1]!.params as { reportEvidenceFile: unknown[] }).reportEvidenceFile).toEqual([{ fileName: payload.screenshot.filename, filePath: "report/earlier/key", originalName: payload.screenshot.filename }]);
		// A garbled preflight state falls back to a new upload.
		const again = consoleAnswers();
		await submitAlibabaCloudSubmission(context, { state: { fileName: 1 } }, dependencies(again as never));
		expect(again.actions().slice(0, 2)).toEqual(["GetUserIdArea", "UploadFileByName"]);
	});

	test("the cross-region path asks for consent: allowCrossRegion is sent only when GetCrossRegionExist is exactly true", async () => {
		for (const [answer, expected] of [[true, true], [false, false], ["true", false], [null, false], [{ Exist: true }, false]] as const) {
			const { context } = await readyContext();
			const console = consoleAnswers({ GetCrossRegionExist: consoleSuccess(answer) });
			await submitAlibabaCloudSubmission(context, undefined, dependencies(console as never));
			const params = console.requests.find((r) => r.action === "SubmitReportTask")!.params as Record<string, unknown>;
			expect(params.allowCrossRegion === true).toBe(expected);
			expect("allowCrossRegion" in params).toBe(expected);
		}
	});

	test("a failing ReportTaskList after SubmitReportTask still succeeds, never resubmits, and falls back to a scalar answer as receipt", async () => {
		for (const failure of ["<html>502</html>", consoleRefusal("NoPermission", "denied"), new Error("socket hang up")]) {
			const { context } = await readyContext();
			const console = consoleAnswers({ ReportTaskList: [failure], SubmitReportTask: consoleSuccess("RT-from-answer") });
			const success = await submitAlibabaCloudSubmission(context, undefined, dependencies(console as never));
			expect(console.count("SubmitReportTask")).toBe(1);
			expect(success).toMatchObject({ confirmationId: "RT-from-answer", confirmationText: "Alibaba Cloud accepted the report.", submittedTargets: [TARGET] });
		}
		const { context } = await readyContext();
		const console = consoleAnswers({ ReportTaskList: ["<html>"] });
		const success = await submitAlibabaCloudSubmission(context, undefined, dependencies(console as never));
		// Object answer ({Env}) and no list: a success without a receipt.
		expect(success.confirmationId).toBeUndefined();
		expect(success.confirmationText).toBe("Alibaba Cloud accepted the report.");
		expect(console.count("SubmitReportTask")).toBe(1);
	});

	test("a numeric answer is a receipt too", async () => {
		const { context } = await readyContext();
		const console = consoleAnswers({ SubmitReportTask: consoleSuccess(123456), ReportTaskList: "<html>" });
		expect((await submitAlibabaCloudSubmission(context, undefined, dependencies(console as never))).confirmationId).toBe("123456");
	});

	test("receipt carries @cn when Alibaba moved the report to the China site, and picks the newest listed match for this object", async () => {
		const { context, payload } = await readyContext();
		const now = Date.now();
		const console = consoleAnswers({
			ReportTaskList: consoleSuccess({ List: [
				{ ReportTaskId: "OTHER-OBJECT", ReportDomainIp: "https://unrelated.example/", ReportStatus: "Valid", GmtCreate: now },
				{ ReportTaskId: "TOO-OLD", ReportDomainIp: payload.report.reportDomainIp, ReportStatus: "Valid", GmtCreate: now - 3_600_000 },
				{ ReportTaskId: "RT-NEW", ReportDomainIp: payload.report.reportDomainIp, ReportStatus: "Valid", GmtCreate: now - 1_000, ExistCrossRegion: true },
				{ ReportTaskId: "RT-NEWER-BUT-OLDER-THAN-NEW", ReportDomainIp: payload.report.reportDomainIp, GmtCreate: now - 2_000 },
			] }),
		});
		expect((await submitAlibabaCloudSubmission(context, undefined, dependencies(console as never))).confirmationId).toBe("RT-NEW@cn");
	});

	test("a refusal of SubmitReportTask is a rejection and files nothing more; a refused area check never reaches submit", async () => {
		const { context } = await readyContext();
		const console = consoleAnswers({ SubmitReportTask: consoleRefusal("ReportReasonInvalid", "bad reason") });
		const failure = await submitAlibabaCloudSubmission(context, undefined, dependencies(console as never)).catch((error) => error);
		expect(failure).toBeInstanceOf(AlibabaConsoleError);
		expect(failure).toBeInstanceOf(ProviderSubmissionRejectedError);
		expect(console.count("SubmitReportTask")).toBe(1);
		expect(console.count("ReportTaskList")).toBe(0);
	});

	test("an ambiguous submit answer (gateway error, network loss) is a plain error, not a rejection", async () => {
		for (const answer of ["<html>504</html>", new Error("socket closed")]) {
			const { context } = await readyContext();
			const console = consoleAnswers({ SubmitReportTask: [answer] });
			const failure = await submitAlibabaCloudSubmission(context, undefined, dependencies(console as never)).catch((error) => error);
			expect(failure).toBeInstanceOf(Error);
			expect(failure).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(console.count("SubmitReportTask")).toBe(1);
		}
	});

	test("ConsoleNeedLogin before the report is filed relogs in once and files exactly once with the fresh session", async () => {
		const { context } = await readyContext();
		const console = consoleAnswers({ GetCrossRegionExist: [NEED_LOGIN, consoleSuccess(false)] });
		const expired: string[] = [];
		await submitAlibabaCloudSubmission(context, { state: { fileName: "f.png", filePath: "k" } }, {
			fetch: console.fetch, config: loginConfig,
			getSession: (async (_config: unknown, options?: { expiredSession?: { id: string } }) => { if (options?.expiredSession) expired.push(options.expiredSession.id); return options?.expiredSession ? freshSession : session; }) as never,
		});
		expect(expired).toEqual(["session-1"]);
		expect(console.count("SubmitReportTask")).toBe(1);
		expect(console.requests.find((r) => r.action === "SubmitReportTask")!.body!.get("sec_token")).toBe("FreshSecToken99");
	});

	test("a tampered or missing draft files nothing", async () => {
		const { context, payload } = await readyContext();
		const console = consoleAnswers();
		const preflight = { state: { fileName: "f.png", filePath: "k" } };
		await expect(submitAlibabaCloudSubmission({ ...context, payload: { ...payload, report: { ...payload.report, reportDomainIp: "https://evil.example/" } } }, preflight, dependencies(console as never))).rejects.toThrow("no longer matches");
		await expect(submitAlibabaCloudSubmission({ ...context, payload: {} }, preflight, dependencies(console as never))).rejects.toThrow("malformed");
		expect(console.count("SubmitReportTask")).toBe(0);
	});

	test("passes the worker's abort signal to every request", async () => {
		const { context } = await readyContext();
		const controller = new AbortController();
		const signals: Array<AbortSignal | null | undefined> = [];
		const console = consoleAnswers();
		await submitAlibabaCloudSubmission({ ...context, signal: controller.signal }, undefined, {
			config: loginConfig, getSession: async () => session,
			fetch: async (url, init) => { signals.push(init.signal); return console.fetch(url, init); },
		});
		expect(signals.length).toBeGreaterThan(4);
		expect(signals.every((signal) => signal === controller.signal)).toBeTrue();
	});
});

describe("findAlibabaCloudSubmission", () => {
	test("finds a report whose answer was lost, by its object and filing time, read-only", async () => {
		const { context, payload } = await readyContext();
		const sentAt = new Date();
		const console = consoleAnswers({
			ReportTaskList: consoleSuccess({ List: [{ ReportTaskId: "RT-LOST", ReportDomainIp: payload.report.reportDomainIp, ReportStatus: "Supplementary information", GmtCreate: String(sentAt.getTime() + 5_000), ExistCrossRegion: true }] }),
		});
		expect(await findAlibabaCloudSubmission({ ...context, sentAt }, dependencies(console as never))).toEqual({
			confirmationId: "RT-LOST@cn",
			confirmationText: "Alibaba Cloud lists the report (Supplementary information).",
			finalUrl: "https://report.alibabacloud.com/#/reportRecord/harmInfo",
			submittedTargets: [TARGET],
		});
		expect(console.actions()).toEqual(["ReportTaskList"]);
	});

	test("finds nothing for an empty list, a report filed before the attempt, another object, or a malformed draft", async () => {
		const { context, payload } = await readyContext();
		const sentAt = new Date();
		const list = (items: unknown[]) => dependencies(consoleAnswers({ ReportTaskList: consoleSuccess({ List: items }) }) as never);
		expect(await findAlibabaCloudSubmission({ ...context, sentAt }, list([]))).toBeUndefined();
		expect(await findAlibabaCloudSubmission({ ...context, sentAt }, list([{ ReportTaskId: "OLD", ReportDomainIp: payload.report.reportDomainIp, GmtCreate: sentAt.getTime() - 6 * 60_000 }]))).toBeUndefined();
		expect(await findAlibabaCloudSubmission({ ...context, sentAt }, list([{ ReportTaskId: "X", ReportDomainIp: "https://other.example/", GmtCreate: sentAt.getTime() }]))).toBeUndefined();
		const console = consoleAnswers();
		expect(await findAlibabaCloudSubmission({ ...context, payload: { nope: 1 }, sentAt }, dependencies(console as never))).toBeUndefined();
		expect(console.requests).toHaveLength(0);
	});

	test("accepts a record without a time (cannot be excluded) and a report within the 5-minute clock slack", async () => {
		const { context, payload } = await readyContext();
		const sentAt = new Date();
		const found = (item: unknown) => findAlibabaCloudSubmission({ ...context, sentAt }, dependencies(consoleAnswers({ ReportTaskList: consoleSuccess({ List: [item] }) }) as never));
		expect((await found({ ReportTaskId: 77, ReportDomainIp: payload.report.reportDomainIp }))?.confirmationId).toBe("77");
		expect((await found({ ReportTaskId: "SLACK", ReportDomainIp: payload.report.reportDomainIp, GmtCreate: sentAt.getTime() - 4 * 60_000 }))?.confirmationId).toBe("SLACK");
	});

	test("a failing list is an error for the caller (it is a read-only lookup)", async () => {
		const { context } = await readyContext();
		await expect(findAlibabaCloudSubmission({ ...context, sentAt: new Date() }, dependencies(consoleAnswers({ ReportTaskList: ["<html>"] }) as never))).rejects.toThrow("without JSON");
	});
});

describe("end to end through the execution engine", () => {
	test("prepare, upload before the marker, submit once, record the receipt, and a replay files nothing more", async () => {
		const { created, route } = await alibabaRoute();
		const console = consoleAnswers({
			ReportTaskList: consoleSuccess({ List: [{ ReportTaskId: "RT-E2E", ReportDomainIp: `https://${TARGET}/signin`, ReportStatus: "Valid", GmtCreate: Date.now() + 1_000, ExistCrossRegion: false }] }),
		});
		const deps = dependencies(console as never);
		const provider: ProviderSubmissionProvider = {
			...alibabaCloudProvider,
			prepareExternalSubmission: (context) => prepareAlibabaCloudExternalSubmission(context, deps),
			submit: (context) => submitAlibabaCloudSubmission(context, undefined, deps),
			submitPrepared: (context, preflight) => submitAlibabaCloudSubmission(context, preflight, deps),
		};
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "submitted", runId: expect.any(BigInt) });
		const [run] = await AbuseRepository.listProviderRunsForReport(created.reportId);
		expect(run).toMatchObject({ executionStatus: "completed", confirmationId: "RT-E2E", submittedTargets: [TARGET] });
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("submitted");
		expect(console.count("UploadFileByName")).toBe(1);
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "not_eligible" });
		expect(console.count("SubmitReportTask")).toBe(1);
	});

	test("a console refusal settles the route as rejected; a non-sg account waits for a person", async () => {
		const refused = await alibabaRoute();
		const refusing = dependencies(consoleAnswers({ SubmitReportTask: consoleRefusal("ReportReasonInvalid") }) as never);
		const asProvider = (deps: ReturnType<typeof dependencies>): ProviderSubmissionProvider => ({
			...alibabaCloudProvider,
			prepareExternalSubmission: (context) => prepareAlibabaCloudExternalSubmission(context, deps),
			submitPrepared: (context, preflight) => submitAlibabaCloudSubmission(context, preflight, deps),
		});
		await expect(executeProviderSubmission({ routeId: refused.route.id, provider: asProvider(refusing) })).resolves.toMatchObject({ outcome: "provider_rejected" });

		const china = await alibabaRoute({ target: "china-phish.com" });
		const cn = dependencies(consoleAnswers({ GetUserIdArea: consoleSuccess({ Env: "cn" }) }) as never);
		await expect(executeProviderSubmission({ routeId: china.route.id, provider: asProvider(cn) })).resolves.toMatchObject({ outcome: "needs_human" });
	});

	test("without a screenshot the route is settled as insufficient evidence", async () => {
		const { route } = await alibabaRoute({ screenshot: false });
		await expect(executeProviderSubmission({ routeId: route.id, provider: alibabaCloudProvider })).resolves.toMatchObject({ outcome: "insufficient_evidence" });
	});
});

describe("report records and status", () => {
	test("parseAlibabaReportRecords keeps only entries with a task ID and reads the alternative field names", () => {
		expect(parseAlibabaReportRecords(undefined)).toEqual([]);
		expect(parseAlibabaReportRecords({ List: "x" })).toEqual([]);
		expect(parseAlibabaReportRecords({ List: [null, 1, "a", {}, { ReportTaskId: "" }, { ReportTaskId: null }, { ReportTaskId: {} }] })).toEqual([]);
		expect(parseAlibabaReportRecords({ List: [
			{ ReportTaskId: "A", ReportDomainIp: "https://a/", ReportStatus: "Valid", GmtCreate: 5, ExistCrossRegion: true },
			{ ReportTaskId: 2, ReportObject: "b", Status: "Invalid", CreateTime: "7" },
			{ ReportTaskId: "C", ReportTime: "2026-11-20T10:00:00Z", ExistCrossRegion: "true" },
			{ ReportTaskId: "D", GmtCreate: "garbage", ReportDomainIp: 4, ReportStatus: 5 },
		] })).toEqual([
			{ reportTaskId: "A", existCrossRegion: true, reportDomainIp: "https://a/", status: "Valid", createdAt: 5 },
			{ reportTaskId: "2", existCrossRegion: false, reportDomainIp: "b", status: "Invalid", createdAt: 7 },
			{ reportTaskId: "C", existCrossRegion: false, createdAt: Date.parse("2026-11-20T10:00:00Z") },
			{ reportTaskId: "D", existCrossRegion: false },
		]);
	});

	test("the live empty ReportTaskList parses to nothing", () => {
		expect(parseAlibabaReportRecords({ PageSize: 20, Total: 0, List: [], Page: 1 })).toEqual([]);
	});

	test("parseAlibabaReportStatus: the last step is the status, final states end polling, notes become detail and messages", () => {
		const at = Date.parse("2026-11-21T08:00:00Z");
		const parsed = parseAlibabaReportStatus("RT1", { ReportStatusList: [
			{ ReportStatus: "Pending", GmtCreate: at - 1000 },
			{ ReportStatus: "Supplementary information", GmtCreate: at, Remark: " Please send more ", Reason: "unclear", Result: "" },
		] });
		expect(parsed.status).toEqual({ state: "Supplementary information", detail: "Please send more unclear" });
		expect(parsed.final).toBeFalse();
		expect(parsed.messages).toEqual([
			{ id: "RT1:0:Pending", subject: "Alibaba Cloud report RT1: Pending", body: "Pending", sentAt: new Date(at - 1000) },
			{ id: "RT1:1:Supplementary information", subject: "Alibaba Cloud report RT1: Supplementary information", body: "Supplementary information\n\nPlease send more\n\nunclear", sentAt: new Date(at) },
		]);
		for (const state of ["Completed", "Invalid", "Revoked", "Abnormal", "Withdrawal"]) {
			expect(parseAlibabaReportStatus("R", { ReportStatusList: [{ ReportStatus: state }] }).final).toBeTrue();
		}
		for (const state of ["Valid", "Notify rectification", "Pending", "Supplementary information", "completed"]) {
			expect(parseAlibabaReportStatus("R", { ReportStatusList: [{ ReportStatus: state }] }).final).toBeFalse();
		}
	});

	test("steps without a time yield a status but no message; garbage steps are skipped; nothing parsed has no status", () => {
		const parsed = parseAlibabaReportStatus("R", { ReportStatusList: [null, "x", { ReportStatus: "" }, { ReportStatus: 4 }, { ReportStatus: "Valid" }] });
		expect(parsed).toEqual({ messages: [], status: { state: "Valid" }, final: false });
		expect(parseAlibabaReportStatus("R", undefined)).toEqual({ messages: [] });
		expect(parseAlibabaReportStatus("R", { ReportStatusList: {} })).toEqual({ messages: [] });
		expect(parseAlibabaReportStatus("R", { ReportStatusList: [] })).toEqual({ messages: [] });
		// Time fields in order of preference, ISO strings and numeric strings alike.
		const times = parseAlibabaReportStatus("R", { ReportStatusList: [{ ReportStatus: "A", Time: "1000" }, { ReportStatus: "B", ProcessTime: "2026-11-21T00:00:00Z" }, { ReportStatus: "C", GmtModified: 5 }] });
		expect(times.messages.map((m) => m.sentAt.getTime())).toEqual([1000, Date.parse("2026-11-21T00:00:00Z"), 5]);
	});

	test("the verdict of every review state the provider maps is reachable, and unmapped ones give none", () => {
		const verdicts = alibabaCloudProvider.reviewVerdicts!;
		expect(verdicts.Pending).toBeUndefined();
		for (const state of ["Revoked", "Withdrawal"]) expect(verdicts[state]).toBeUndefined();
		// Every final state with a verdict is terminal in the parser.
		for (const state of ["Completed", "Invalid", "Abnormal"]) {
			expect(verdicts[state]).toBeDefined();
			expect(parseAlibabaReportStatus("R", { ReportStatusList: [{ ReportStatus: state }] }).final).toBeTrue();
		}
	});

	test("fetchAlibabaCloudCorrespondence asks GetReportStatus for the task, with the region from the receipt suffix", async () => {
		const answer = consoleSuccess({ ReportStatusList: [{ ReportStatus: "Completed", GmtCreate: 1_700_000_000_000, Remark: "Taken down" }] });
		for (const [receipt, region] of [["RT9", false], ["RT9@cn", true], ["RT9@xx", false]] as const) {
			const console = fakeConsoleFetch({ GetReportStatus: answer });
			const result = await fetchAlibabaCloudCorrespondence({ confirmationId: receipt }, dependencies(console as never));
			expect(console.requests[0]!.params).toEqual({ reportTaskId: "RT9", existCrossRegion: region, pageType: "harmInfo" });
			expect(result).toMatchObject({ final: true, status: { state: "Completed", detail: "Taken down" } });
			expect(result.messages[0]).toMatchObject({ id: "RT9:0:Completed", sentAt: new Date(1_700_000_000_000) });
		}
		await expect(fetchAlibabaCloudCorrespondence({ confirmationId: "" }, dependencies(fakeConsoleFetch({}) as never))).rejects.toThrow("receipt ID is empty");
		await expect(fetchAlibabaCloudCorrespondence({ confirmationId: "@cn" }, dependencies(fakeConsoleFetch({}) as never))).rejects.toThrow("receipt ID is empty");
	});

	test("polling relogs in once on an expired session and surfaces refusals", async () => {
		const answer = consoleSuccess({ ReportStatusList: [{ ReportStatus: "Valid", GmtCreate: 5 }] });
		const console = fakeConsoleFetch({ GetReportStatus: [NEED_LOGIN, answer] });
		let logins = 0;
		const result = await fetchAlibabaCloudCorrespondence({ confirmationId: "RT1" }, { fetch: console.fetch, config: loginConfig, getSession: (async () => (++logins === 1 ? session : freshSession)) as never });
		expect(result.status?.state).toBe("Valid");
		expect(logins).toBe(2);
		await expect(fetchAlibabaCloudCorrespondence({ confirmationId: "RT1" }, dependencies(fakeConsoleFetch({ GetReportStatus: consoleRefusal("ReportNotFound") }) as never))).rejects.toBeInstanceOf(AlibabaConsoleError);
	});
});

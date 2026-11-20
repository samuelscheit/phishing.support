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
	recordTime,
	submitAlibabaCloudSubmission,
} from "./submission";
import { consoleRefusal, consoleTime, consoleSuccess, fakeConsoleFetch, freshSession, loginConfig, NEED_LOGIN, session, SUCCESS_ENV_SG, UPLOAD_POLICY } from "./test_support";

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
/** The state a preflight returns, built by hand: the account's listing before filing and the stored screenshot. */
const preflightOf = (payload: { screenshot: { filename: string } }, listedTaskIds: string[] = [], filePath: string = UPLOAD_POLICY.Key) =>
	({ state: { payload, evidenceFile: { fileName: payload.screenshot.filename, filePath }, session, listedTaskIds } });
const listed = (...items: Array<Record<string, unknown>>) => consoleSuccess({ PageSize: 20, Total: items.length, Page: 1, List: items });

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

	test("missing credentials need a person rather than drafting", async () => {
		const { route } = await alibabaRoute();
		delete process.env.ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL;
		const noEmail = await prepareAlibabaCloudSubmission({ routeId: route.id, payload: {} }).catch((error) => error);
		expect(noEmail).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(noEmail.message).toContain("ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL");
		process.env.ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL = loginConfig.email;
		delete process.env.ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD;
		const noPassword = await prepareAlibabaCloudSubmission({ routeId: route.id, payload: {} }).catch((error) => error);
		expect(noPassword).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(noPassword.message).toContain("ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD");
	});

	test("an unknown route fails", async () => {
		await expect(prepareAlibabaCloudSubmission({ routeId: 999_999n, payload: {} })).rejects.toThrow("no longer exists");
	});
});

describe("preflight: area check and evidence upload", () => {
	test("uploads the screenshot under its generated name and returns payload, stored file, session and the current listing as state; nothing is filed", async () => {
		const { context, payload } = await readyContext();
		const console = consoleAnswers({ ReportTaskList: listed({ ReportTaskId: "BEFORE-1", ReportDomainIp: payload.report.reportDomainIp }, { ReportTaskId: "BEFORE-2", ReportDomainIp: "https://x.example/" }) });
		const preflight = await prepareAlibabaCloudExternalSubmission(context, dependencies(console as never));
		expect(preflight).toEqual({ state: { payload, evidenceFile: { fileName: payload.screenshot.filename, filePath: UPLOAD_POLICY.Key }, session, listedTaskIds: ["BEFORE-1", "BEFORE-2"] } });
		expect(console.actions()).toEqual(["GetUserIdArea", "UploadFileByName", "ReportTaskList"]);
		expect(console.count("SubmitReportTask")).toBe(0);
		expect(console.requests[1]!.params).toEqual({ name: payload.screenshot.filename });
		const sent = [...console.requests[2]!.form!.entries()].at(-1)![1] as unknown as File;
		expect(Buffer.from(await sent.arrayBuffer()).equals(PNG)).toBeTrue();
	});

	test("an account outside the international site needs a person, before any upload", async () => {
		const { context } = await readyContext();
		for (const env of ["cn", "us", " sg"]) {
			const console = consoleAnswers({ GetUserIdArea: consoleSuccess({ Env: env }) });
			const failure = await prepareAlibabaCloudExternalSubmission(context, dependencies(console as never)).catch((error) => error);
			expect(failure).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
			expect(failure.message).toContain(`Env ${env}`);
			expect(console.actions()).toEqual(["GetUserIdArea"]);
		}
	});

	test("a missing or empty Env is a plain, retryable error, not a verdict on the account", async () => {
		const { context } = await readyContext();
		for (const data of [null, {}, { Env: "" }, { Env: 1 }, "sg"]) {
			const console = consoleAnswers({ GetUserIdArea: consoleSuccess(data) });
			const failure = await prepareAlibabaCloudExternalSubmission(context, dependencies(console as never)).catch((error) => error);
			expect(failure).toBeInstanceOf(Error);
			expect(failure).not.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
			expect(failure).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(console.actions()).toEqual(["GetUserIdArea"]);
		}
	});

	test("an expired session is replaced once and the state carries the fresh one", async () => {
		const { context } = await readyContext();
		const console = consoleAnswers({ GetUserIdArea: [NEED_LOGIN, SUCCESS_ENV_SG] });
		const preflight = await prepareAlibabaCloudExternalSubmission(context, {
			fetch: console.fetch, config: loginConfig,
			getSession: (async (_config: unknown, options?: { expiredSession?: unknown }) => (options?.expiredSession ? freshSession : session)) as never,
		});
		expect((preflight.state as { session: unknown }).session).toBe(freshSession);
	});

	test("a failing listing fails the preflight before any filing", async () => {
		const { context } = await readyContext();
		const console = consoleAnswers({ ReportTaskList: ["<html>"] });
		await expect(prepareAlibabaCloudExternalSubmission(context, dependencies(console as never))).rejects.toThrow("without JSON");
		expect(console.count("SubmitReportTask")).toBe(0);
	});

	test("a malformed, mismatched or tampered draft fails before any console call", async () => {
		const { context, payload, created } = await readyContext();
		const console = consoleAnswers();
		const run = (candidate: Record<string, unknown>, routeId = context.routeId) => prepareAlibabaCloudExternalSubmission({ routeId, payload: candidate }, dependencies(console as never));
		await expect(run({})).rejects.toThrow("malformed");
		await expect(run({ ...payload, report: { ...payload.report, reportReason: "Totally different reason" } })).rejects.toThrow("no longer matches the report");
		await expect(run({ ...payload, report: { ...payload.report, impactItem: "https://other-bank.com/" } })).rejects.toThrow("no longer matches the report");
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
	test("after the marker only GetCrossRegionExist, SubmitReportTask and ReportTaskList run; the receipt is the new listed record", async () => {
		const { context, payload } = await readyContext();
		const now = Date.now();
		const console = consoleAnswers({
			ReportTaskList: listed(
				{ ReportTaskId: "BEFORE-1", ReportDomainIp: payload.report.reportDomainIp, ReportStatus: "举报成立", GmtCreated: consoleTime(now) },
				{ ReportTaskId: "RT-20261120-1", ReportDomainIp: payload.report.reportDomainIp, ReportStatus: "举报成立", GmtCreated: consoleTime(now - 1_000), ExistCrossRegion: false },
			),
		});
		const success = await submitAlibabaCloudSubmission(context, preflightOf(payload, ["BEFORE-1"]), dependencies(console as never));
		expect(console.actions()).toEqual(["GetCrossRegionExist", "SubmitReportTask", "ReportTaskList"]);
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

	test("the preflight's stored file and session are used: no area check, no upload, no login", async () => {
		const { context, payload } = await readyContext();
		const console = consoleAnswers();
		let logins = 0;
		await submitAlibabaCloudSubmission(context, preflightOf(payload, [], "report/earlier/key"), { fetch: console.fetch, config: loginConfig, getSession: (async () => { logins += 1; return session; }) as never });
		expect(console.actions()).toEqual(["GetCrossRegionExist", "SubmitReportTask", "ReportTaskList"]);
		expect((console.requests[1]!.params as { reportEvidenceFile: unknown[] }).reportEvidenceFile).toEqual([{ fileName: payload.screenshot.filename, filePath: "report/earlier/key", originalName: payload.screenshot.filename }]);
		expect(console.requests[0]!.body!.get("sec_token")).toBe(session.secToken);
		// Only the listing afterwards asks for a session.
		expect(logins).toBe(1);
	});

	test("a missing or incomplete preflight state is an error that files nothing, never a fallback upload", async () => {
		const { context, payload } = await readyContext();
		const full = preflightOf(payload).state;
		for (const preflight of [undefined, {}, { state: undefined }, { state: {} }, { state: { ...full, payload: undefined } }, { state: { ...full, evidenceFile: undefined } }, { state: { ...full, session: undefined } }, { state: { ...full, listedTaskIds: undefined } }, { state: { fileName: "f.png", filePath: "k" } }]) {
			const console = consoleAnswers();
			const failure = await submitAlibabaCloudSubmission(context, preflight as never, dependencies(console as never)).catch((error) => error);
			expect(failure).toBeInstanceOf(Error);
			// `undefined` has no state to read at all; every other shape is named.
			if (preflight) expect(failure.message).toContain("no prepared state");
			expect(console.requests).toHaveLength(0);
		}
	});

	test("the provider's plain submit rejects: Alibaba files only from prepared state", async () => {
		const { context } = await readyContext();
		await expect(alibabaCloudProvider.submit(context as never)).rejects.toThrow("only from its prepared state");
	});

	test("the cross-region path asks for consent: allowCrossRegion is sent only when GetCrossRegionExist is exactly true", async () => {
		for (const [answer, expected] of [[true, true], [false, false], ["true", false], [null, false], [{ Exist: true }, false]] as const) {
			const { context, payload } = await readyContext();
			const console = consoleAnswers({ GetCrossRegionExist: consoleSuccess(answer) });
			await submitAlibabaCloudSubmission(context, preflightOf(payload), dependencies(console as never));
			const params = console.requests.find((r) => r.action === "SubmitReportTask")!.params as Record<string, unknown>;
			expect(params.allowCrossRegion === true).toBe(expected);
			expect("allowCrossRegion" in params).toBe(expected);
		}
	});

	test("a failing ReportTaskList after SubmitReportTask still succeeds, never resubmits, and falls back to a scalar answer as receipt", async () => {
		for (const failure of ["<html>502</html>", consoleRefusal("NoPermission", "denied"), new Error("socket hang up")]) {
			const { context, payload } = await readyContext();
			const console = consoleAnswers({ ReportTaskList: [failure], SubmitReportTask: consoleSuccess("RT-from-answer") });
			const success = await submitAlibabaCloudSubmission(context, preflightOf(payload), dependencies(console as never));
			expect(console.count("SubmitReportTask")).toBe(1);
			expect(success).toMatchObject({ confirmationId: "RT-from-answer", confirmationText: "Alibaba Cloud accepted the report.", submittedTargets: [TARGET] });
		}
		const { context, payload } = await readyContext();
		const console = consoleAnswers({ ReportTaskList: ["<html>"] });
		const success = await submitAlibabaCloudSubmission(context, preflightOf(payload), dependencies(console as never));
		// Object answer ({Env}) and no list: a success without a receipt.
		expect(success.confirmationId).toBeUndefined();
		expect(success.confirmationText).toBe("Alibaba Cloud accepted the report.");
		expect(console.count("SubmitReportTask")).toBe(1);
	});

	test("a scalar answer is a receipt only when it looks like a task ID; a numeric one does", async () => {
		const { context, payload } = await readyContext();
		const receipt = async (answer: unknown) => (await submitAlibabaCloudSubmission(context, preflightOf(payload), dependencies(consoleAnswers({ SubmitReportTask: consoleSuccess(answer), ReportTaskList: "<html>" }) as never))).confirmationId;
		expect(await receipt(123456)).toBe("123456");
		expect(await receipt("abcd")).toBe("abcd");
		expect(await receipt("a_b-C9")).toBe("a_b-C9");
		expect(await receipt("a".repeat(64))).toBe("a".repeat(64));
		for (const bad of ["successful", "ok ok", "abc", "", "a".repeat(65), "with space", "ü-ünï", 12, true, null, ["RT-1"]]) {
			if (bad === "successful") expect(await receipt(bad)).toBe("successful"); // 10 plain characters are a legal ID shape
			else expect(await receipt(bad)).toBeUndefined();
		}
	});

	test("a listed record that was already listed before filing is never the receipt; the scalar answer then is", async () => {
		const { context, payload } = await readyContext();
		const console = consoleAnswers({
			SubmitReportTask: consoleSuccess("RT-ANSWER"),
			ReportTaskList: listed({ ReportTaskId: "BEFORE", ReportDomainIp: payload.report.reportDomainIp, GmtCreated: consoleTime(Date.now()) }),
		});
		expect((await submitAlibabaCloudSubmission(context, preflightOf(payload, ["BEFORE"]), dependencies(console as never))).confirmationId).toBe("RT-ANSWER");
		const none = consoleAnswers({ ReportTaskList: listed({ ReportTaskId: "BEFORE", ReportDomainIp: payload.report.reportDomainIp }) });
		expect((await submitAlibabaCloudSubmission(context, preflightOf(payload, ["BEFORE"]), dependencies(none as never))).confirmationId).toBeUndefined();
	});

	test("receipt carries @cn when Alibaba moved the report to the China site, and picks the newest new listed match for this object", async () => {
		const { context, payload } = await readyContext();
		const now = Date.now();
		const console = consoleAnswers({
			ReportTaskList: listed(
				{ ReportTaskId: "OTHER-OBJECT", ReportDomainIp: "https://unrelated.example/", ReportStatus: "举报成立", GmtCreated: consoleTime(now) },
				{ ReportTaskId: "BEFORE", ReportDomainIp: payload.report.reportDomainIp, ReportStatus: "举报成立", GmtCreated: consoleTime(now + 5_000) },
				{ ReportTaskId: "RT-NEW", ReportDomainIp: payload.report.reportDomainIp, ReportStatus: "举报成立", GmtCreated: consoleTime(now - 1_000), ExistCrossRegion: true },
				{ ReportTaskId: "RT-OLDER", ReportDomainIp: payload.report.reportDomainIp, GmtCreated: consoleTime(now - 2_000) },
			),
		});
		expect((await submitAlibabaCloudSubmission(context, preflightOf(payload, ["BEFORE"]), dependencies(console as never))).confirmationId).toBe("RT-NEW@cn");
	});

	test("a refusal of SubmitReportTask is a rejection and files nothing more", async () => {
		const { context, payload } = await readyContext();
		const console = consoleAnswers({ SubmitReportTask: consoleRefusal("ReportReasonInvalid", "bad reason") });
		const failure = await submitAlibabaCloudSubmission(context, preflightOf(payload), dependencies(console as never)).catch((error) => error);
		expect(failure).toBeInstanceOf(AlibabaConsoleError);
		expect(failure).toBeInstanceOf(ProviderSubmissionRejectedError);
		expect(console.count("SubmitReportTask")).toBe(1);
		expect(console.count("ReportTaskList")).toBe(0);
	});

	test("an ambiguous submit answer (gateway error, network loss) is a plain error, not a rejection", async () => {
		for (const answer of ["<html>504</html>", new Error("socket closed")]) {
			const { context, payload } = await readyContext();
			const console = consoleAnswers({ SubmitReportTask: [answer] });
			const failure = await submitAlibabaCloudSubmission(context, preflightOf(payload), dependencies(console as never)).catch((error) => error);
			expect(failure).toBeInstanceOf(Error);
			expect(failure).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(console.count("SubmitReportTask")).toBe(1);
		}
	});

	test("ConsoleNeedLogin before the report is filed relogs in once and files exactly once with the fresh session", async () => {
		const { context, payload } = await readyContext();
		const console = consoleAnswers({ GetCrossRegionExist: [NEED_LOGIN, consoleSuccess(false)] });
		const expired: string[] = [];
		await submitAlibabaCloudSubmission(context, preflightOf(payload), {
			fetch: console.fetch, config: loginConfig,
			getSession: (async (_config: unknown, options?: { expiredSession?: { id: string } }) => { if (options?.expiredSession) expired.push(options.expiredSession.id); return options?.expiredSession ? freshSession : session; }) as never,
		});
		expect(expired).toEqual(["session-1"]);
		expect(console.count("SubmitReportTask")).toBe(1);
		expect(console.requests.find((r) => r.action === "SubmitReportTask")!.body!.get("sec_token")).toBe("FreshSecToken99");
	});

	test("a refused fresh session, or no relogin, needs a person and files nothing", async () => {
		const { context, payload } = await readyContext();
		const refused = consoleAnswers({ GetCrossRegionExist: NEED_LOGIN });
		const twice = await submitAlibabaCloudSubmission(context, preflightOf(payload), {
			fetch: refused.fetch, config: loginConfig, getSession: (async (_config: unknown, options?: { expiredSession?: unknown }) => (options?.expiredSession ? freshSession : session)) as never,
		}).catch((error) => error);
		expect(twice).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(refused.count("SubmitReportTask")).toBe(0);
		const noLogin = consoleAnswers({ GetCrossRegionExist: NEED_LOGIN });
		const failed = await submitAlibabaCloudSubmission(context, preflightOf(payload), {
			fetch: noLogin.fetch, config: loginConfig, getSession: (async () => { throw new Error("login refused"); }) as never,
		}).catch((error) => error);
		expect(failed).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(noLogin.count("SubmitReportTask")).toBe(0);
	});

	test("passes the worker's abort signal to every request", async () => {
		const { context, payload } = await readyContext();
		const controller = new AbortController();
		const signals: Array<AbortSignal | null | undefined> = [];
		const console = consoleAnswers();
		await submitAlibabaCloudSubmission({ ...context, signal: controller.signal }, preflightOf(payload), {
			config: loginConfig, getSession: async () => session,
			fetch: async (url, init) => { signals.push(init.signal); return console.fetch(url, init); },
		});
		expect(signals).toHaveLength(3);
		expect(signals.every((signal) => signal === controller.signal)).toBeTrue();
	});
});

describe("findAlibabaCloudSubmission", () => {
	test("finds a report whose answer was lost, by its object and filing time, read-only", async () => {
		const { context, payload } = await readyContext();
		const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
		const console = consoleAnswers({
			ReportTaskList: consoleSuccess({ List: [{ ReportTaskId: "RT-LOST", ReportDomainIp: payload.report.reportDomainIp, ReportStatus: "补充资料", GmtCreated: consoleTime(sentAt.getTime() + 5_000), ExistCrossRegion: true }] }),
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
		expect(await findAlibabaCloudSubmission({ ...context, sentAt }, list([{ ReportTaskId: "OLD", ReportDomainIp: payload.report.reportDomainIp, GmtCreated: consoleTime(sentAt.getTime() - 2 * 60_000) }]))).toBeUndefined();
		expect(await findAlibabaCloudSubmission({ ...context, sentAt }, list([{ ReportTaskId: "X", ReportDomainIp: "https://other.example/", GmtCreated: consoleTime(sentAt.getTime()) }]))).toBeUndefined();
		const console = consoleAnswers();
		expect(await findAlibabaCloudSubmission({ ...context, payload: { nope: 1 }, sentAt }, dependencies(console as never))).toBeUndefined();
		expect(console.requests).toHaveLength(0);
	});

	test("a record without a parseable time never matches; one within 60 s before the attempt does, an older one does not", async () => {
		const { context, payload } = await readyContext();
		const sentAt = new Date(Math.floor(Date.now() / 1000) * 1000);
		const found = (item: Record<string, unknown>) => findAlibabaCloudSubmission({ ...context, sentAt }, dependencies(consoleAnswers({ ReportTaskList: consoleSuccess({ List: [{ ReportDomainIp: payload.report.reportDomainIp, ...item }] }) }) as never));
		expect(await found({ ReportTaskId: "77" })).toBeUndefined();
		expect(await found({ ReportTaskId: "77", GmtCreated: "garbage" })).toBeUndefined();
		expect((await found({ ReportTaskId: "SLACK", GmtCreated: consoleTime(sentAt.getTime() - 59_000) }))?.confirmationId).toBe("SLACK");
		expect((await found({ ReportTaskId: "EDGE", GmtCreated: consoleTime(sentAt.getTime() - 60_000) }))?.confirmationId).toBe("EDGE");
		expect(await found({ ReportTaskId: "OLD", GmtCreated: consoleTime(sentAt.getTime() - 61_000) })).toBeUndefined();
		// A console time is UTC+8: read as UTC it would be 8 hours too early.
		const utcMisread = new Date(sentAt.getTime() + 5_000).toISOString().slice(0, 19).replace("T", " ");
		expect(await found({ ReportTaskId: "UTC-MISREAD", GmtCreated: utcMisread })).toBeUndefined();
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
			ReportTaskList: [listed(), listed({ ReportTaskId: "RT-E2E", ReportDomainIp: `https://${TARGET}/signin`, ReportStatus: "已创建", GmtCreated: consoleTime(Date.now() + 1_000), ExistCrossRegion: false })],
		});
		const deps = dependencies(console as never);
		const provider: ProviderSubmissionProvider = {
			...alibabaCloudProvider,
			prepareExternalSubmission: (context) => prepareAlibabaCloudExternalSubmission(context, deps),
			submitPrepared: (context, preflight) => submitAlibabaCloudSubmission(context, preflight, deps),
		};
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "submitted", runId: expect.any(BigInt) });
		const [run] = await AbuseRepository.listProviderRunsForReport(created.reportId);
		expect(run).toMatchObject({ executionStatus: "completed", confirmationId: "RT-E2E", submittedTargets: [TARGET] });
		expect((await AbuseRepository.getRoute(route.id))?.status).toBe("submitted");
		expect(console.count("UploadFileByName")).toBe(1);
		expect(console.count("GetUserIdArea")).toBe(1);
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
	const REAL_RECORD = { ExistCrossRegion: false, TypeReport: "Phishing Scams", ErrorStatus: 0, GmtCreated: "2026-11-20 18:24:26", ReportStatus: "已创建", ReportTaskId: "202611205170266473080", ReportDomainIp: "https://darksword.helicha.com/" };
	const REAL_STATUS = { ReportStatusList: [{ CreateTime: "2026-11-20 18:24:26", ReportStatus: "已创建" }, { CreateTime: "2026-11-20 18:25:03", ReportStatus: "处理中" }] };
	const step = (state: string, at?: string) => ({ ReportStatus: state, ...(at ? { CreateTime: at } : {}) });

	test("parseAlibabaReportRecords reads the real console list: UTC+8 time, translated state, cross-region flag", () => {
		expect(parseAlibabaReportRecords({ PageSize: 20, Total: 1, List: [REAL_RECORD], Page: 1 })).toEqual([
			{ reportTaskId: "202611205170266473080", existCrossRegion: false, reportDomainIp: "https://darksword.helicha.com/", status: "Created", createdAt: Date.parse("2026-11-20T10:24:26Z") },
		]);
		expect(parseAlibabaReportRecords({ List: [{ ...REAL_RECORD, ExistCrossRegion: true }] })[0]!.existCrossRegion).toBeTrue();
	});

	test("parseAlibabaReportRecords keeps only entries with a task ID and drops malformed fields", () => {
		expect(parseAlibabaReportRecords(undefined)).toEqual([]);
		expect(parseAlibabaReportRecords({ List: "x" })).toEqual([]);
		expect(parseAlibabaReportRecords({ List: [null, 1, "a", {}, { ReportTaskId: "" }, { ReportTaskId: null }, { ReportTaskId: {} }] })).toEqual([]);
		expect(parseAlibabaReportRecords({ List: [
			{ ReportTaskId: 2, ExistCrossRegion: "true" },
			{ ReportTaskId: "D", GmtCreated: "garbage", ReportDomainIp: 4, ReportStatus: 5 },
		] })).toEqual([
			{ reportTaskId: "2", existCrossRegion: false },
			{ reportTaskId: "D", existCrossRegion: false },
		]);
	});

	test("the old guessed field names are not read", () => {
		expect(parseAlibabaReportRecords({ List: [{ ReportTaskId: "A", ReportObject: "b", Status: "Valid", GmtCreate: 1_700_000_000_000, CreateTime: "1700000001", ReportTime: "1700000002" }] }))
			.toEqual([{ reportTaskId: "A", existCrossRegion: false }]);
		const parsed = parseAlibabaReportStatus("R", { ReportStatusList: [{ ReportStatus: "已创建", Time: 1, ProcessTime: 2, GmtModified: 3, GmtCreate: 4 }] });
		expect(parsed).toEqual({ messages: [], status: { state: "Created" }, final: false });
	});

	test("the live empty ReportTaskList parses to nothing", () => {
		expect(parseAlibabaReportRecords({ PageSize: 20, Total: 0, List: [], Page: 1 })).toEqual([]);
	});

	test("REPORT_STATES translates every Chinese state; unknown labels pass through unchanged", () => {
		const expected: Record<string, string> = {
			已创建: "Created", 待认领: "Assigning", 处理中: "Processing", 自动化审理中: "Automated review", 补充资料: "Supplementary information",
			暂不处理: "Abnormal", 已完结: "Completed", 举报成立: "Valid", 已撤诉: "Withdrawal", 已撤销: "Revoked", 通知整改: "Notify rectification", 举报不成立: "Invalid",
		};
		for (const [chinese, english] of Object.entries(expected)) {
			expect(parseAlibabaReportStatus("R", { ReportStatusList: [step(chinese)] }).status).toEqual({ state: english });
			expect(parseAlibabaReportRecords({ List: [{ ReportTaskId: "A", ReportStatus: chinese }] })[0]!.status).toBe(english);
		}
		expect(parseAlibabaReportStatus("R", { ReportStatusList: [step(" 全新状态 ")] }).status).toEqual({ state: "全新状态" });
		expect(parseAlibabaReportRecords({ List: [{ ReportTaskId: "A", ReportStatus: "Brand new" }] })[0]!.status).toBe("Brand new");
	});

	test("parseAlibabaReportStatus reads the real steps: last is the status, polling goes on, messages at UTC+8 times", () => {
		const parsed = parseAlibabaReportStatus("202611205170266473080", REAL_STATUS);
		const created = Date.parse("2026-11-20T10:24:26Z");
		const processing = Date.parse("2026-11-20T10:25:03Z");
		expect(parsed.status).toEqual({ state: "Processing" });
		expect(parsed.final).toBeFalse();
		expect(parsed.messages).toEqual([
			{ id: `202611205170266473080:Created:${created}`, subject: "Alibaba Cloud report 202611205170266473080: Created", body: "Created", sentAt: new Date(created) },
			{ id: `202611205170266473080:Processing:${processing}`, subject: "Alibaba Cloud report 202611205170266473080: Processing", body: "Processing", sentAt: new Date(processing) },
		]);
	});

	test("notes, when a step has them, become detail and message body", () => {
		const at = "2026-11-21 16:00:00";
		const parsed = parseAlibabaReportStatus("RT1", { ReportStatusList: [{ ...step("补充资料", at), Remark: " Please send more ", Reason: "unclear", Result: "" }] });
		expect(parsed.status).toEqual({ state: "Supplementary information", detail: "Please send more unclear" });
		expect(parsed.messages[0]).toMatchObject({ body: "Supplementary information\n\nPlease send more\n\nunclear", sentAt: new Date("2026-11-21T08:00:00Z") });
	});

	test("final states end polling, the others do not, and only the translated name counts", () => {
		for (const state of ["已完结", "举报不成立", "已撤销", "暂不处理", "已撤诉"]) {
			expect(parseAlibabaReportStatus("R", { ReportStatusList: [step(state)] }).final).toBeTrue();
		}
		for (const state of ["举报成立", "通知整改", "已创建", "处理中", "自动化审理中", "补充资料", "待认领", "completed"]) {
			expect(parseAlibabaReportStatus("R", { ReportStatusList: [step(state)] }).final).toBeFalse();
		}
	});

	test("steps without a time yield a status but no message; garbage steps are skipped; nothing parsed has no status", () => {
		const parsed = parseAlibabaReportStatus("R", { ReportStatusList: [null, "x", { ReportStatus: "" }, { ReportStatus: 4 }, step("举报成立")] });
		expect(parsed).toEqual({ messages: [], status: { state: "Valid" }, final: false });
		expect(parseAlibabaReportStatus("R", undefined)).toEqual({ messages: [] });
		expect(parseAlibabaReportStatus("R", { ReportStatusList: {} })).toEqual({ messages: [] });
		expect(parseAlibabaReportStatus("R", { ReportStatusList: [] })).toEqual({ messages: [] });
		const times = parseAlibabaReportStatus("R", { ReportStatusList: [step("已创建", "1700000000"), step("处理中", "2026-11-21T00:00:00Z"), step("已完结", "2026-11-21 08:00:00")] });
		expect(times.messages.map((m) => m.sentAt.getTime())).toEqual([1_700_000_000_000, Date.parse("2026-11-21T00:00:00Z"), Date.parse("2026-11-21T00:00:00Z")]);
		expect(times.status?.state).toBe("Completed");
	});

	test("steps are sorted oldest first when every step has a time, whatever order the console lists them; otherwise the listed order stays", () => {
		const newestFirst = parseAlibabaReportStatus("RT", { ReportStatusList: [
			step("已完结", "2026-11-21 10:00:00"),
			step("举报成立", "2026-11-20 09:00:00"),
			step("处理中", "2026-11-19 08:00:00"),
		] });
		expect(newestFirst.messages.map((m) => m.id)).toEqual([
			`RT:Processing:${Date.parse("2026-11-19T00:00:00Z")}`,
			`RT:Valid:${Date.parse("2026-11-20T01:00:00Z")}`,
			`RT:Completed:${Date.parse("2026-11-21T02:00:00Z")}`,
		]);
		expect(newestFirst.status).toEqual({ state: "Completed" });
		expect(newestFirst.final).toBeTrue();
		// One step without a time: no sorting, the last listed one is the status.
		const partial = parseAlibabaReportStatus("RT", { ReportStatusList: [step("已完结", "2026-11-21 10:00:00"), step("举报成立"), step("处理中", "2026-11-19 08:00:00")] });
		expect(partial.messages.map((m) => m.id)).toEqual([`RT:Completed:${Date.parse("2026-11-21T02:00:00Z")}`, `RT:Processing:${Date.parse("2026-11-19T00:00:00Z")}`]);
		expect(partial.status).toEqual({ state: "Processing" });
		// The same state at two times stays two distinct messages.
		const repeated = parseAlibabaReportStatus("RT", { ReportStatusList: [step("举报成立", "2026-11-20 09:00:00"), step("举报成立", "2026-11-20 09:10:00")] });
		expect(new Set(repeated.messages.map((m) => m.id)).size).toBe(2);
	});

	test("recordTime: epoch seconds and milliseconds, numbers and strings, console time as UTC+8, zones as given", () => {
		expect(recordTime(1_700_000_000)).toBe(1_700_000_000_000);
		expect(recordTime("1700000000")).toBe(1_700_000_000_000);
		expect(recordTime(1_700_000_000_000)).toBe(1_700_000_000_000);
		expect(recordTime("1700000000000")).toBe(1_700_000_000_000);
		expect(recordTime(99_999_999_999)).toBe(99_999_999_999_000);
		expect(recordTime(100_000_000_000)).toBe(100_000_000_000);
		expect(recordTime("2026-11-20 18:07:56")).toBe(Date.parse("2026-11-20T10:07:56Z"));
		expect(recordTime("2026-11-20T18:07:56")).toBe(Date.parse("2026-11-20T10:07:56Z"));
		expect(recordTime(" 2026-11-20 18:07:56 ")).toBe(Date.parse("2026-11-20T10:07:56Z"));
		expect(recordTime("2026-11-20T18:07:56Z")).toBe(Date.parse("2026-11-20T18:07:56Z"));
		expect(recordTime("2026-11-20 18:07:56Z")).toBe(Date.parse("2026-11-20T18:07:56Z"));
		expect(recordTime("2026-11-20T18:07:56+02:00")).toBe(Date.parse("2026-11-20T16:07:56Z"));
		expect(recordTime("2026-11-20T18:07:56-05:00")).toBe(Date.parse("2026-11-20T23:07:56Z"));
		for (const bad of [undefined, null, "", "  ", "garbage", {}, [], true, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(recordTime(bad)).toBeUndefined();
	});

	test("the verdict of every review state the provider maps is reachable, and unmapped ones give none", () => {
		const verdicts = alibabaCloudProvider.reviewVerdicts!;
		for (const state of ["Created", "Processing", "Automated review", "Assigning", "Revoked", "Withdrawal"]) expect(verdicts[state]).toBeUndefined();
		// The verdicts are keyed by the English names the Chinese states translate to.
		const chinese: Record<string, string> = { 举报成立: "Valid", 通知整改: "Notify rectification", 已完结: "Completed", 补充资料: "Supplementary information", 举报不成立: "Invalid", 暂不处理: "Abnormal" };
		for (const [label, english] of Object.entries(chinese)) {
			expect(verdicts[english]).toBeDefined();
			expect(parseAlibabaReportStatus("R", { ReportStatusList: [step(label)] }).status?.state).toBe(english);
		}
		// Every final state with a verdict is terminal in the parser.
		for (const label of ["已完结", "举报不成立", "暂不处理"]) {
			expect(parseAlibabaReportStatus("R", { ReportStatusList: [step(label)] }).final).toBeTrue();
		}
	});

	test("fetchAlibabaCloudCorrespondence asks GetReportStatus for the task, with the region from the receipt suffix", async () => {
		const answer = consoleSuccess({ ReportStatusList: [{ ReportStatus: "已完结", CreateTime: "2026-11-20 18:25:03", Remark: "Taken down" }] });
		for (const [receipt, region] of [["RT9", false], ["RT9@cn", true], ["RT9@xx", false]] as const) {
			const console = fakeConsoleFetch({ GetReportStatus: answer });
			const result = await fetchAlibabaCloudCorrespondence({ confirmationId: receipt }, dependencies(console as never));
			expect(console.requests[0]!.params).toEqual({ reportTaskId: "RT9", existCrossRegion: region, pageType: "harmInfo" });
			expect(result).toMatchObject({ final: true, status: { state: "Completed", detail: "Taken down" } });
			expect(result.messages[0]).toMatchObject({ id: `RT9:Completed:${Date.parse("2026-11-20T10:25:03Z")}`, sentAt: new Date("2026-11-20T10:25:03Z") });
		}
		await expect(fetchAlibabaCloudCorrespondence({ confirmationId: "" }, dependencies(fakeConsoleFetch({}) as never))).rejects.toThrow("receipt ID is empty");
		await expect(fetchAlibabaCloudCorrespondence({ confirmationId: "@cn" }, dependencies(fakeConsoleFetch({}) as never))).rejects.toThrow("receipt ID is empty");
	});

	test("polling relogs in once on an expired session and surfaces refusals", async () => {
		const answer = consoleSuccess({ ReportStatusList: [{ ReportStatus: "举报成立", CreateTime: "2026-11-20 18:25:03" }] });
		const console = fakeConsoleFetch({ GetReportStatus: [NEED_LOGIN, answer] });
		let logins = 0;
		const result = await fetchAlibabaCloudCorrespondence({ confirmationId: "RT1" }, { fetch: console.fetch, config: loginConfig, getSession: (async () => (++logins === 1 ? session : freshSession)) as never });
		expect(result.status?.state).toBe("Valid");
		expect(logins).toBe(2);
		await expect(fetchAlibabaCloudCorrespondence({ confirmationId: "RT1" }, dependencies(fakeConsoleFetch({ GetReportStatus: consoleRefusal("ReportNotFound") }) as never))).rejects.toBeInstanceOf(AlibabaConsoleError);
	});
});

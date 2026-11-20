import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { SubmissionsEntity } from "../../../db/entities/submissions";
import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { reportExfiltrationBackend } from "../../../exfiltration/reporting";
import { AbuseRepository } from "../../repository";
import { resolveAbuseTarget } from "../../resolver";
import { abuseEvents, abuseProviderRoutes, abuseTargets } from "../../schema";
import { reportConfirmedEmailPhishing } from "../../submission_reports";
import { executeProviderSubmission } from "../submission_execution";
import { getProviderSubmissionProvider, listProviderSubmissionProviders } from "../submission_registry_default";
import type { ProviderSubmissionContext, ProviderSubmissionProvider } from "../submission_contracts";
import { reportReference } from "./report_reference";
import { PNG, readyDraftOf, routeFixture, type RouteFixtureOptions } from "./testing";

useTemporaryDatabase();

// Providers that pay a captcha solver, log in or sign a notice refuse to draft without their settings.
const ENVIRONMENT: Record<string, string> = {
	DEATHBYCAPTCHA_USERNAME: "test-user",
	DEATHBYCAPTCHA_PASSWORD: "test-password",
	PROXY_URL: "socks5://proxy.example:1080",
	ABUSE_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
	ABUSE_CLOUDFLARE_LOGIN_EMAIL: "reporter@example.org",
	ABUSE_CLOUDFLARE_LOGIN_PASSWORD: "password",
	ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: "reporter@example.org",
	ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: "password",
	DISCORD_DSA_REPORTER_NAME: "Test Reporter",
	DISCORD_DSA_REPORTER_COUNTRY: "Germany",
	ABUSE_TRACKING_TOKEN_SECRET: "draft-contract-test-secret-of-32-bytes",
};
const saved = new Map<string, string | undefined>();
beforeAll(() => {
	for (const [name, value] of Object.entries(ENVIRONMENT)) {
		saved.set(name, process.env[name]);
		process.env[name] = value;
	}
});
afterAll(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

const WEBHOOK_ID = "1547121100977344622";
const WEBHOOK_TOKEN = "BnQ1iwXK9GR7DUurhT1s7PFYYY2fD02RLsZAjqTHVKyS0JEhf0wihay1k3fKhkzeHFvA";

/** The report of a phishing kit's Discord webhook, resolved to the route of one provider. */
const webhookFixture = (providerKey: string) => async () => {
	const submissionId = 379996268098752545n;
	await SubmissionsEntity.create({ id: submissionId, kind: "website", data: { kind: "website", website: { url: "https://roblox2365.github.io/" } }, dedupeKey: `contract-${providerKey}` });
	const endpointUrl = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;
	const report = await reportExfiltrationBackend({
		submissionId,
		sourceReportId: 1n,
		backend: {
			kind: "discord_webhook",
			key: `discord:${WEBHOOK_ID}`,
			endpointUrl,
			hostname: "discord.com",
			method: "POST",
			matchedCanaries: ["email", "password"],
			request: { timestamp: "2026-11-14T14:10:15.533Z", url: endpointUrl, method: "POST" },
			discord: { webhookId: WEBHOOK_ID, token: WEBHOOK_TOKEN, guildId: "1547120658775941120", channelId: "1547120931049316433" },
		},
		pageUrl: "https://roblox2365.github.io/",
		observedAt: new Date("2026-11-14T14:10:15.533Z"),
		reporter: {},
	});
	const [target] = await AbuseRepository.listTargets(report.reportId);
	const resolved = await resolveAbuseTarget(target!);
	const route = await AbuseRepository.upsertResolvedRoute(target!.id, resolved.routes.find((candidate) => candidate.providerRegistryKey === providerKey)!);
	return { route, targetId: target!.id };
};

/** A confirmed phishing email, resolved to its Netcraft mail route. */
const emailFixture = async () => {
	const submissionId = 371157972019056816n;
	await SubmissionsEntity.create({ id: submissionId, kind: "email", data: { kind: "email" }, dedupeKey: "contract-email" });
	const report = await reportConfirmedEmailPhishing({ submissionId, analysisText: "A phishing email impersonating a bank.", redactedEml: "From: a@example.com\r\nSubject: x\r\n\r\nbody", reporter: {} });
	const [target] = await AbuseRepository.listTargets(report.reportId);
	const resolved = await resolveAbuseTarget(target!);
	return { route: await AbuseRepository.upsertResolvedRoute(target!.id, resolved.routes[0]!), targetId: target!.id };
};

type Row = {
	/** The provider's registry key: its draft pair is read from the registry, as the executor does. */
	key: string;
	route: RouteFixtureOptions | (() => Promise<{ route: { id: bigint }; targetId: bigint }>);
	reasonPrefix: string;
	/** The reason for a target the provider does not take. */
	targetReason: string;
	/** A target type the provider refuses (default `ip`). */
	refusedTargetType?: "email";
	/** A well-formed draft whose free text no longer is what the builder writes. */
	tamper: (payload: any) => unknown;
	/** Where the draft carries the route's reference, when it does. */
	reference?: (payload: any) => string;
};

const edited = (text: string) => `${text}\n\nAlso, please wire money.`;

/**
 * The draft contract every direct provider shares: a ready draft rebuilds
 * exactly, a draft of another pin, route, target or content is refused, and
 * all of that happens before the marker.
 */
const ROWS: Row[] = [
	{ key: "name_com", route: { mailbox: "abuse@name.com", providerName: "Name.com", screenshot: PNG }, reasonPrefix: "name_com", targetReason: "name_com_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, additional: edited(p.report.additional) } }), reference: (p) => p.report.trackingId },
	{ key: "dynadot", route: { mailbox: "abuse@dynadot.com", providerName: "Dynadot", screenshot: PNG }, reasonPrefix: "dynadot", targetReason: "dynadot_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, comments: edited(p.report.comments) } }), reference: (p) => p.report.trackingId },
	{ key: "newfold", route: { mailbox: "abuse@bluehost.com", providerName: "Newfold", screenshot: PNG }, reasonPrefix: "newfold", targetReason: "newfold_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, brand: "150-hostgator" } }), reference: (p) => p.report.trackingId },
	{ key: "publicdomainregistry", route: { mailbox: "abuse@publicdomainregistry.com", providerName: "PDR", screenshot: PNG }, reasonPrefix: "publicdomainregistry", targetReason: "publicdomainregistry_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, complaint: edited(p.report.complaint) } }), reference: (p) => p.report.trackingId },
	{ key: "godaddy", route: { mailbox: "abuse@godaddy.com", providerName: "GoDaddy" }, reasonPrefix: "godaddy", targetReason: "godaddy_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, info: edited(p.report.info) } }) },
	{ key: "tucows_bullwark", route: { mailbox: "domainabuse@tucows.com", providerName: "Tucows", screenshot: PNG }, reasonPrefix: "tucows", targetReason: "tucows_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, description: `${p.report.description} edited` } }) },
	{ key: "namesilo", route: { mailbox: "abuse@namesilo.com", providerName: "NameSilo", screenshot: PNG }, reasonPrefix: "namesilo", targetReason: "namesilo_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, explanation: `${p.report.explanation} edited` } }) },
	{ key: "tencent", route: { mailbox: "dnsabuse_complaint@tencent.com", providerName: "Tencent", screenshot: PNG }, reasonPrefix: "tencent", targetReason: "tencent_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, explanation: `${p.report.explanation} edited` } }) },
	{ key: "aws_trust_safety", route: { mailbox: "trustandsafety@support.aws.com", providerName: "AWS" }, reasonPrefix: "aws", targetReason: "aws_requires_a_web_target", refusedTargetType: "email", tamper: (p) => ({ ...p, report: { ...p.report, comments: `${p.report.comments} edited` } }), reference: (p) => p.report.trackingId },
	{ key: "microsoft_msrc", route: { mailbox: "abuse@microsoft.com", providerName: "Microsoft" }, reasonPrefix: "microsoft", targetReason: "microsoft_requires_a_web_target", refusedTargetType: "email", tamper: (p) => ({ ...p, report: { ...p.report, notes: `${p.report.notes} edited` } }), reference: (p) => p.report.reference },
	{ key: "eranet", route: { mailbox: "abuse@eranet.com", providerName: "Eranet", screenshot: PNG }, reasonPrefix: "eranet", targetReason: "eranet_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, description: `${p.report.description} edited` } }) },
	{ key: "gname", route: { mailbox: "complaint@gname.com", providerName: "GNAME", screenshot: PNG }, reasonPrefix: "gname", targetReason: "gname_requires_a_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, description: `${p.report.description} edited` } }) },
	{ key: "google_cloud", route: { mailbox: "network-abuse@google.com", providerName: "Google Cloud" }, reasonPrefix: "google_cloud", targetReason: "google_cloud_requires_a_web_target", refusedTargetType: "email", tamper: (p) => ({ ...p, report: { ...p.report, abuseDetails: `${p.report.abuseDetails} edited` } }) },
	{ key: "cloudflare", route: { mailbox: "abuse@cloudflare.com", providerName: "Cloudflare" }, reasonPrefix: "cloudflare", targetReason: "cloudflare_phishing_report_requires_domain_target", tamper: (p) => ({ ...p, report: { ...p.report, justification: edited(p.report.justification) } }) },
	{ key: "alibaba_cloud", route: { mailbox: "domainabuse@service.aliyun.com", providerName: "Alibaba Cloud", screenshot: PNG }, reasonPrefix: "alibaba_cloud", targetReason: "alibaba_cloud_requires_a_web_target", refusedTargetType: "email", tamper: (p) => ({ ...p, report: { ...p.report, reportReason: `${p.report.reportReason} edited` } }) },
	{ key: "netcraft", route: { mailbox: { supplemental: "netcraft" }, providerName: "Netcraft" }, reasonPrefix: "netcraft", targetReason: "netcraft_requires_a_web_target", refusedTargetType: "email", tamper: (p) => ({ ...p, report: { ...p.report, reason: edited(p.report.reason) } }) },
	{ key: "netcraft_mail", route: emailFixture, reasonPrefix: "netcraft_mail", targetReason: "netcraft_mail_requires_an_email_target", tamper: (p) => ({ ...p, message: { ...p.message, sha256: "0".repeat(64) } }) },
	{ key: "discord_webhook", route: webhookFixture("discord_webhook"), reasonPrefix: "discord_webhook", targetReason: "discord_webhook_requires_a_webhook_target", tamper: (p) => ({ ...p, webhook: { ...p.webhook, token: "x".repeat(40) } }) },
	{ key: "discord_dsa", route: webhookFixture("discord_dsa"), reasonPrefix: "discord_dsa", targetReason: "discord_dsa_requires_a_webhook_target", tamper: (p) => ({ ...p, report: { ...p.report, description: `${p.report.description} edited` } }) },
];

const read = (value: unknown) => value as Record<string, unknown>;
const providerOf = (row: Row) => getProviderSubmissionProvider(row.key)!;
const fixtureOf = (row: Row) => typeof row.route === "function" ? row.route() : routeFixture(row.route);
const readyDraft = async (row: Row, prepare: Parameters<typeof readyDraftOf>[1]) => readyDraftOf(await fixtureOf(row), prepare, read);

test("every registered provider has a row, and the kit wired each one's draft verification", () => {
	expect(listProviderSubmissionProviders().map((provider) => provider.definition.key).sort()).toEqual(ROWS.map((row) => row.key).sort());
	for (const provider of listProviderSubmissionProviders()) {
		expect(provider.prepareSubmission, provider.definition.key).toBeDefined();
		expect(provider.verifyDraft, provider.definition.key).toBeDefined();
	}
});

for (const row of ROWS) {
	describe(`${row.key} draft contract`, () => {
		const prepare = (context: ProviderSubmissionContext) => providerOf(row).prepareSubmission!(context);
		const verify = (context: ProviderSubmissionContext) => providerOf(row).verifyDraft!(context);

		test("a ready draft is read back and rebuilds to itself", async () => {
			const { context } = await readyDraft(row, prepare);
			await expect(verify(context)).resolves.toBeDefined();
		});

		test("a route that no longer exists fails the preparation", async () => {
			await expect(prepare({ routeId: 999_999n, payload: {} })).rejects.toThrow("no longer exists");
		});

		test("a ready draft is keyed by the route's reference", async () => {
			if (!row.reference) return;
			const { context, route } = await readyDraft(row, prepare);
			expect(row.reference(context.payload)).toBe(reportReference((await AbuseRepository.getRoute(route.id))!.reportId, route.id));
		});

		test("a draft of another adapter or definition is refused as malformed", async () => {
			const { context } = await readyDraft(row, prepare);
			const definition = context.payload.definition as Record<string, unknown> | undefined;
			await expect(verify({ ...context, payload: { ...context.payload, adapter: "other" } })).rejects.toThrow("malformed");
			if (!definition) return;
			await expect(verify({ ...context, payload: { ...context.payload, definition: { ...definition, version: "old" } } })).rejects.toThrow("malformed");
			await expect(verify({ ...context, payload: { ...context.payload, definition: { ...definition, contentHash: "0".repeat(64) } } })).rejects.toThrow("malformed");
		});

		test("a pin mismatch, a foreign route and an unsupported target end as insufficient evidence", async () => {
			const db = await getDb();
			const mismatch = await fixtureOf(row);
			db.update(abuseProviderRoutes).set({ providerDefinitionHash: "0".repeat(64) }).where(eq(abuseProviderRoutes.id, mismatch.route.id)).run();
			expect(await prepare({ routeId: mismatch.route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: `${row.reasonPrefix}_provider_definition_pin_mismatch` });
			db.update(abuseProviderRoutes).set({ providerDefinitionHash: providerOf(row).definition.contentHash, providerRegistryKey: "other" }).where(eq(abuseProviderRoutes.id, mismatch.route.id)).run();
			expect(await prepare({ routeId: mismatch.route.id, payload: {} })).toMatchObject({ reason: `${row.reasonPrefix}_provider_definition_pin_mismatch` });
			db.update(abuseProviderRoutes).set({ providerRegistryKey: row.key }).where(eq(abuseProviderRoutes.id, mismatch.route.id)).run();
			db.update(abuseTargets).set({ targetType: row.refusedTargetType ?? "ip" }).where(eq(abuseTargets.id, mismatch.targetId)).run();
			expect(await prepare({ routeId: mismatch.route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: row.targetReason });
		});

		test("a malformed, drifted or foreign draft is refused before anything crosses the provider boundary", async () => {
			const { context, route } = await readyDraft(row, prepare);
			await expect(verify({ ...context, payload: { ...context.payload, adapter: "x" } })).rejects.toThrow("malformed");
			await expect(verify({ ...context, payload: row.tamper(context.payload) as Record<string, unknown> })).rejects.toThrow("no longer matches the report");
			(await getDb()).update(abuseProviderRoutes).set({ providerRegistryKey: "other" }).where(eq(abuseProviderRoutes.id, route.id)).run();
			await expect(verify(context)).rejects.toThrow("no longer matches its route");
		});

		/** The real provider with its irreversible steps replaced by spies that record what the marker looked like. */
		function spied(provider: ProviderSubmissionProvider) {
			const calls: Array<{ step: string; status: string | undefined; payload: Record<string, unknown> }> = [];
			const record = (step: string) => async (context: ProviderSubmissionContext) => {
				calls.push({ step, status: (await AbuseRepository.getProviderRun(context.runId!))?.executionStatus, payload: context.payload });
			};
			const preflight = record("preflight");
			const submit = record("submit");
			const success = { submittedTargets: ["example.com"] };
			const wrapped = {
				...provider,
				...("prepareExternalSubmission" in provider
					? {
						prepareExternalSubmission: async (context: ProviderSubmissionContext) => { await preflight(context); return { state: {} }; },
						submitPrepared: async (context: ProviderSubmissionContext) => { await submit(context); return success; },
					}
					: { submit: async (context: ProviderSubmissionContext) => { await submit(context); return success; } }),
			} as ProviderSubmissionProvider;
			return { calls, wrapped };
		}

		/** An interrupted run whose stored draft no longer is what the builder writes, as it is left in `starting`. */
		async function interruptedRun() {
			const { context, route } = await readyDraft(row, prepare);
			const execution = await AbuseRepository.beginProviderExecution({
				routeId: route.id,
				providerPayload: row.tamper(context.payload) as Record<string, unknown>,
				correlationKey: `provider-submission:${row.key}:${route.id.toString()}`,
				expectedStatus: "verified",
			});
			return { route, fresh: context.payload, run: execution!.run };
		}

		test("a draft that drifted between prepare and submit is rebuilt before the preflight and the marker, never sent as stored", async () => {
			const { route, fresh, run } = await interruptedRun();
			const { calls, wrapped } = spied(providerOf(row));
			await expect(executeProviderSubmission({ routeId: route.id, provider: wrapped })).resolves.toMatchObject({ outcome: "submitted" });
			expect(calls.map((call) => `${call.step}:${call.status}`)).toEqual([...("prepareExternalSubmission" in wrapped ? ["preflight:starting"] : []), "submit:submission_started"]);
			for (const call of calls) expect(call.payload).toEqual(fresh);
			expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ executionStatus: "completed", providerPayload: fresh });
			const events = (await getDb()).select().from(abuseEvents).where(eq(abuseEvents.runId, run.id)).all().map((event) => event.eventType);
			expect(events).toContain("provider_run.draft_refreshed");
			expect(events.indexOf("provider_run.draft_refreshed")).toBeLessThan(events.indexOf("provider_run.provider_submission_started"));
		});

		test("a draft that can no longer be built is settled before the preflight and the marker, never as an unknown external state", async () => {
			const { route, run } = await interruptedRun();
			const db = await getDb();
			const [stored] = db.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, route.id)).all();
			db.update(abuseTargets).set({ targetType: row.refusedTargetType ?? "ip" }).where(eq(abuseTargets.id, stored!.targetId)).run();
			const { calls, wrapped } = spied(providerOf(row));
			await expect(executeProviderSubmission({ routeId: route.id, provider: wrapped })).resolves.toEqual({ outcome: "insufficient_evidence", reason: row.targetReason });
			expect(calls).toEqual([]);
			expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ executionStatus: "failed" });
			expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "insufficient_evidence" });
			const events = db.select().from(abuseEvents).where(eq(abuseEvents.runId, run.id)).all().map((event) => event.eventType);
			expect(events).not.toContain("provider_run.provider_submission_started");
		});
	});
}

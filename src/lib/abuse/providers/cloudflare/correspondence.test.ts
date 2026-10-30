import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { abuseJobs, abuseProviderRuns } from "../../schema";
import { ensureCorrespondencePolls, pollProviderCorrespondence } from "../../worker/correspondence";
import { cloudflareApiConfig } from "./api";
import { cloudflareSessionKey } from "./session";
import { sqliteCloudflareSessionStore } from "./session-store";
import { fetchCloudflareCorrespondence } from "./submission";

const ACCOUNT_ID = "b9077acfb4ef45e0f94b0f52c06c289a";
const environment = { ABUSE_CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, ABUSE_CLOUDFLARE_LOGIN_EMAIL: "operator@example.com", ABUSE_CLOUDFLARE_LOGIN_PASSWORD: "test-password" };
const session = { atok: "old-atok", vses2: "cookie", expiresAt: Date.now() + 86_400_000 };
const fresh = { ...session, atok: "fresh-atok" };
const base = `https://dash.cloudflare.com/api/v4/accounts/${ACCOUNT_ID}/abuse-reports/submitted/ddfb9a8d1137a9e7`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The two emails production's report ddfb9a8d1137a9e7 received, as the API returned them. */
const emailsPage = {
	result: {
		emails: [
			{ id: "60f11347-8c97-47b5-8df9-7a1a5215c8f4", subject: "[ddfb9a8d1137a9e7]: Response to your Phishing report", body: "We have restricted access to the reported URL(s).", recipient: "support@phishing.support", sent_at: "2026-10-23T15:20:31.438982Z" },
			{ id: "7587b571-c118-4ea4-ac4f-a8b76b4566c4", subject: "ddfb9a8d1137a9e7: Abuse Report Confirmation", body: "Cloudflare received your Phishing report.", recipient: "support@phishing.support", sent_at: "2026-10-23T15:13:08.245784Z" },
		],
	},
	success: true,
	result_info: { page: 1, per_page: 100, count: 2, total_count: 2, total_pages: 1 },
};
const detail = { result: { id: "ddfb9a8d1137a9e7", status: "accepted", denial_reason: null }, success: true };

describe("Cloudflare submitted-report correspondence", () => {
	test("reads the report status and every delivered email with GET requests only", async () => {
		const requests: Array<{ url: string; method?: string; atok?: string }> = [];
		const result = await fetchCloudflareCorrespondence({ confirmationId: "ddfb9a8d1137a9e7" }, {
			environment,
			getSession: async () => session,
			fetch: async (url, init) => {
				requests.push({ url, method: init?.method, atok: (init?.headers as Record<string, string>)["x-atok"] });
				return json(url.includes("/emails") ? emailsPage : detail);
			},
		});
		expect(requests).toEqual([
			{ url: base, method: "GET", atok: "old-atok" },
			{ url: `${base}/emails?page=1&per_page=100`, method: "GET", atok: "old-atok" },
		]);
		expect(result.status).toEqual({ state: "accepted" });
		expect(result.messages.map(({ id, sentAt }) => ({ id, sentAt: sentAt.toISOString() }))).toEqual([
			{ id: "60f11347-8c97-47b5-8df9-7a1a5215c8f4", sentAt: "2026-10-23T15:20:31.438Z" },
			{ id: "7587b571-c118-4ea4-ac4f-a8b76b4566c4", sentAt: "2026-10-23T15:13:08.245Z" },
		]);
	});

	test("logs in once more only after an explicit expired-session response", async () => {
		let logins = 0;
		const result = await fetchCloudflareCorrespondence({ confirmationId: "ddfb9a8d1137a9e7" }, {
			environment,
			getSession: async (_config, options) => { logins++; return options?.expiredSession ? fresh : session; },
			fetch: async (url, init) => (init?.headers as Record<string, string>)["x-atok"] === "old-atok"
				? json({ result: "error", err_code: 9300 }, 403)
				: json(url.includes("/emails") ? emailsPage : { ...detail, result: { ...detail.result, status: "denied", denial_reason: "Not phishing" } }),
		});
		expect(logins).toBe(2);
		expect(result.status).toEqual({ state: "denied", detail: "Not phishing" });
	});

	test("rejects a receipt that is not a submitted-report ID before any request", async () => {
		await expect(fetchCloudflareCorrespondence({ confirmationId: "../../user" }, {
			environment,
			getSession: async () => session,
			fetch: async () => { throw new Error("must not request"); },
		})).rejects.toThrow("not a submitted-report ID");
	});
});

describe("Cloudflare correspondence polling", () => {
	useTemporaryDatabase();
	const originalEnvironment = { ...process.env };
	afterEach(() => {
		for (const key of Object.keys(environment)) {
			if (originalEnvironment[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnvironment[key];
		}
		globalThis.fetch = originalFetch;
	});
	const originalFetch = globalThis.fetch;

	async function submittedCloudflareRoute(submittedDaysAgo = 0) {
		const request = await validateAbuseReportRequest({ targets: ["satin-alerts-kennedy-scenic.trycloudflare.com"], allegationCategory: "phishing", description: "Payment kit." });
		const report = await AbuseRepository.createReport({ request, reporter: {} });
		const [target] = await AbuseRepository.listTargets(report.reportId);
		const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
			routeKey: "provider:cloudflare", providerRegistryKey: "cloudflare", providerDisplayName: "Cloudflare Abuse",
			routeType: "provider_submission", resolverProvenance: { source: "test" }, resolutionSnapshot: { source: "test" }, status: "verified",
		});
		const run = await AbuseRepository.createProviderRun({ routeId: route.id, providerPayload: {}, correlationKey: `cf:${route.id.toString()}` });
		await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId: "ddfb9a8d1137a9e7", submittedTargets: ["satin-alerts-kennedy-scenic.trycloudflare.com"] });
		if (submittedDaysAgo) {
			(await getDb()).update(abuseProviderRuns).set({ createdAt: new Date(Date.now() - submittedDaysAgo * 86_400_000) }).where(eq(abuseProviderRuns.id, run.id)).run();
		}
		return { reportId: report.reportId, route };
	}

	async function pollJobs(routeId: bigint) {
		return (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.routeId, routeId)).all().filter((job) => job.jobType === "poll_provider_correspondence");
	}

	test("records Cloudflare's emails and status once, then schedules the next hourly read", async () => {
		Object.assign(process.env, environment);
		await sqliteCloudflareSessionStore.writeSession(cloudflareSessionKey(cloudflareApiConfig(environment)), session);
		globalThis.fetch = (async (url: string) => json(String(url).includes("/emails") ? emailsPage : detail)) as typeof fetch;
		const { reportId, route } = await submittedCloudflareRoute();
		await ensureCorrespondencePolls();
		const [first] = await pollJobs(route.id);
		expect(first).toMatchObject({ status: "queued" });

		await pollProviderCorrespondence({ routeId: route.id, jobId: first!.id });
		await pollProviderCorrespondence({ routeId: route.id, jobId: first!.id });
		const mail = (await AbuseRepository.listMailForReport(reportId)).filter((message) => message.routeId === route.id);
		expect(mail.map(({ kind, subject }) => ({ kind, subject }))).toEqual([
			{ kind: "provider_api", subject: "ddfb9a8d1137a9e7: Abuse Report Confirmation" },
			{ kind: "provider_api", subject: "[ddfb9a8d1137a9e7]: Response to your Phishing report" },
			{ kind: "provider_api", subject: "Report status: accepted" },
		]);
		const queued = (await pollJobs(route.id)).filter((job) => job.id !== first!.id);
		expect(queued).toHaveLength(1);
		expect(queued[0]!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
	});

	test("stops polling a report submitted more than 30 days ago", async () => {
		const { route } = await submittedCloudflareRoute(31);
		await ensureCorrespondencePolls();
		expect(await pollJobs(route.id)).toEqual([]);
	});

	test("immediately queues one origin-host follow-up for a newly recorded disclosure", async () => {
		Object.assign(process.env, environment);
		await sqliteCloudflareSessionStore.writeSession(cloudflareSessionKey(cloudflareApiConfig(environment)), session);
		const hostPage = {
			...emailsPage,
			result: {
				emails: [{
					...emailsPage.result.emails[0],
					body: "The host for the reported domain is:\nabuse@hosting.example\nYou may use this information to follow up directly with the hosting provider.",
				}],
			},
		};
		globalThis.fetch = (async (url: string) => json(String(url).includes("/emails") ? hostPage : detail)) as typeof fetch;
		const { reportId, route } = await submittedCloudflareRoute();
		await ensureCorrespondencePolls();
		const [first] = await pollJobs(route.id);
		await pollProviderCorrespondence({ routeId: route.id, jobId: first!.id });
		await pollProviderCorrespondence({ routeId: route.id, jobId: first!.id });
		const jobs = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.reportId, reportId)).all();
		expect(jobs.filter(({ jobType }) => jobType === "report_origin_host")).toHaveLength(1);
	});
});

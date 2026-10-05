import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { abuseJobs } from "../../schema";
import { netcraftSubmissionUrl, netcraftSubmissionUrlsUrl, type NetcraftFetch } from "../../../netcraft/api";

import { NETCRAFT_PROVIDER } from "./definition";
import { reconcileNetcraftProviderRun } from "./reconcile";

useTemporaryDatabase();

const submissionId = "lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV";
const reportInput = {
	targets: ["shop.hd-media.space"],
	allegationCategory: "phishing" as const,
	description: "The captured page impersonates a service and collects login credentials.",
	observedUrls: [{ target: "shop.hd-media.space", urls: ["https://shop.hd-media.space/"] }],
};

beforeEach(() => {
	process.env.ABUSE_TRACKING_TOKEN_SECRET = "01234567890123456789012345678901";
});

async function createUnresolvedCase(options: { diagnosticId?: string; job?: boolean } = {}) {
	const request = await validateAbuseReportRequest(reportInput);
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	if (!target) throw new Error("Expected the test target to be persisted.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: `provider_submission:netcraft:reconcile:${created.reportId.toString()}`,
		providerRegistryKey: NETCRAFT_PROVIDER.key,
		providerDisplayName: NETCRAFT_PROVIDER.displayName,
		routeType: "provider_submission",
		providerDefinitionVersion: NETCRAFT_PROVIDER.version,
		providerDefinitionHash: NETCRAFT_PROVIDER.contentHash,
		resolverProvenance: { source: "netcraft_reconciliation_test" },
		resolutionSnapshot: { source: "netcraft_reconciliation_test" },
		status: "unknown_external_state",
	});
	const run = await AbuseRepository.createProviderRun({
		routeId: route.id,
		providerPayload: { adapter: "netcraft_report_urls_v3", providerNarrativeVersion: 1 },
		correlationKey: `provider-submission:netcraft:reconcile:${created.reportId.toString()}`,
		executionStatus: "unknown_external_state",
	});
	let job: Awaited<ReturnType<typeof AbuseRepository.enqueueJob>> | undefined;
	if (options.job !== false) {
		job = await AbuseRepository.enqueueJob({
			jobType: "submit_provider",
			reportId: created.reportId,
			routeId: route.id,
			payload: {},
			dedupeKey: `submit-provider:netcraft:reconcile:${created.reportId.toString()}`,
		});
		const db = await getDb();
		db.update(abuseJobs)
			.set({ status: "unknown_external_state", unknownExternalState: true, lastError: "Netcraft response could not be classified." })
			.where(and(eq(abuseJobs.id, job.id), eq(abuseJobs.status, "queued")))
			.run();
	}
	if (options.diagnosticId !== undefined) {
		await AbuseRepository.updateProviderRun(run.id, {
			failureReason: `Netcraft report did not include a valid submission UUID: {"uuid":"${options.diagnosticId}"}`,
		});
	}
	return { ...created, target, route, run, job };
}

function mockedReceiptFetch(expectedUrl: string, options: { mismatch?: boolean; extra?: boolean } = {}): { fetch: NetcraftFetch; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		fetch: async (input, init) => {
			const url = String(input);
			calls.push(url);
			expect(init?.method).toBe("GET");
			expect(init?.redirect).toBe("error");
			if (url === netcraftSubmissionUrl(expectedUrl)) {
				return new Response(JSON.stringify({ state: "malicious", pending: 0, has_urls: 1, last_update: 1_788_181_361 }));
			}
			if (url === netcraftSubmissionUrlsUrl(expectedUrl)) {
				return new Response(JSON.stringify({
					filtered_count: 1,
					total_count: 1,
					urls: [
						{ url: options.mismatch ? "https://other.example/" : "https://shop.hd-media.space/", url_state: "malicious" },
						...(options.extra ? [{ url: "https://login.shop.hd-media.space/extra", url_state: "malicious" }] : []),
					],
				}));
			}
			return new Response("unexpected URL", { status: 500 });
		},
	};
}

describe("Netcraft unknown-external-state reconciliation", () => {
	test("verifies the read-only receipt and atomically settles the run, route, job, and aggregate", async () => {
		const context = await createUnresolvedCase({ diagnosticId: submissionId });
		const mocked = mockedReceiptFetch(submissionId);

		await expect(reconcileNetcraftProviderRun({ runId: context.run.id, submissionId, fetch: mocked.fetch })).resolves.toEqual({
			outcome: "reconciled",
			runId: context.run.id,
			confirmationId: submissionId,
			finalUrl: netcraftSubmissionUrl(submissionId),
			providerState: "malicious",
		});
		expect(mocked.calls).toEqual([netcraftSubmissionUrl(submissionId), netcraftSubmissionUrlsUrl(submissionId)]);
		expect(await AbuseRepository.getProviderRun(context.run.id)).toMatchObject({
			executionStatus: "completed",
			confirmationId: submissionId,
			confirmationText: "Netcraft accepted the report and completed its current URL analysis.",
			finalUrl: netcraftSubmissionUrl(submissionId),
			submittedTargets: ["shop.hd-media.space"],
			failureReason: null,
		});
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "submitted" });
		const db = await getDb();
		expect(db.select({ status: abuseJobs.status, unknownExternalState: abuseJobs.unknownExternalState, lastError: abuseJobs.lastError })
			.from(abuseJobs).where(eq(abuseJobs.id, context.job!.id)).get()).toEqual({ status: "completed", unknownExternalState: false, lastError: null });
		expect((await AbuseRepository.getReport(context.reportId))?.status).toBe("submitted");

		const events = await AbuseRepository.listEvents(context.reportId);
		expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
			"provider_run.reconciled",
			"job.reconciled",
			"route.status_changed",
			"report.status_changed",
		]));

		const secondCalls = mocked.calls.length;
		await expect(reconcileNetcraftProviderRun({
			runId: context.run.id,
			submissionId,
			fetch: async () => { throw new Error("A reconciled run must not be fetched again."); },
		})).resolves.toEqual({
			outcome: "already_reconciled",
			runId: context.run.id,
			confirmationId: submissionId,
			finalUrl: netcraftSubmissionUrl(submissionId),
		});
		expect(mocked.calls).toHaveLength(secondCalls);
	});

	test("does not fetch or mutate when the diagnostic receipt ID disagrees", async () => {
		const context = await createUnresolvedCase({ diagnosticId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
		let calls = 0;
		const result = await reconcileNetcraftProviderRun({
			runId: context.run.id,
			submissionId,
			fetch: async () => { calls++; throw new Error("must not fetch"); },
		});
		expect(result).toEqual({ outcome: "not_eligible", reason: "netcraft_submission_id_diagnostic_mismatch" });
		expect(calls).toBe(0);
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "unknown_external_state" });
		expect(await AbuseRepository.getProviderRun(context.run.id)).toMatchObject({ executionStatus: "unknown_external_state" });
	});

	test("does not settle when the verified URL list does not contain the durable target", async () => {
		const context = await createUnresolvedCase({ diagnosticId: submissionId });
		const mocked = mockedReceiptFetch(submissionId, { mismatch: true });
		await expect(reconcileNetcraftProviderRun({ runId: context.run.id, submissionId, fetch: mocked.fetch })).resolves.toEqual({
			outcome: "not_eligible",
			reason: "netcraft_receipt_target_mismatch",
		});
		expect(mocked.calls).toHaveLength(2);
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "unknown_external_state" });
		expect(await AbuseRepository.getProviderRun(context.run.id)).toMatchObject({ executionStatus: "unknown_external_state" });
	});

	test("does not associate a receipt that contains an extra in-scope URL", async () => {
		const context = await createUnresolvedCase({ diagnosticId: submissionId });
		const mocked = mockedReceiptFetch(submissionId, { extra: true });
		await expect(reconcileNetcraftProviderRun({ runId: context.run.id, submissionId, fetch: mocked.fetch })).resolves.toEqual({
			outcome: "not_eligible",
			reason: "netcraft_receipt_target_mismatch",
		});
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "unknown_external_state" });
	});
});

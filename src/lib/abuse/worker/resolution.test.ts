import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { abuseJobs } from "../schema";
import { AbuseWorker } from "../worker";
import { resolveReport } from "./resolution";

useTemporaryDatabase();

const reportPayload = {
	targets: ["example.com"],
	allegationCategory: "phishing" as const,
	description: "A credential-harvesting page impersonates the protected brand.",
	observedUrls: [{ target: "example.com", urls: ["https://login.example.com/collect"] }],
};

async function createReport() {
	process.env.ABUSE_TRACKING_TOKEN_SECRET = "01234567890123456789012345678901";
	const request = await validateAbuseReportRequest(reportPayload);
	return AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
}

describe("direct provider resolution and dispatch", () => {
	test("queues a verified provider-submission route with its own durable job", async () => {
		const created = await createReport();

		await resolveReport(created.reportId, async () => ({
			status: "resolved",
			resolverSnapshot: { source: "direct_provider_resolution_test" },
			routes: [{
				routeKey: "provider_submission:test-provider:contact",
				providerRegistryKey: "test-provider",
				providerDisplayName: "Test Provider",
				routeType: "provider_submission",
				providerDefinitionVersion: "test-v1",
				providerDefinitionHash: "a".repeat(64),
				resolverProvenance: { source: "direct_provider_resolution_test" },
				resolutionSnapshot: { source: "direct_provider_resolution_test" },
				verificationResult: { verified: true },
				status: "verified",
			}],
		}));

		const [route] = await AbuseRepository.listRoutes(created.reportId);
		expect(route).toMatchObject({ routeType: "provider_submission", status: "verified" });
		const db = await getDb();
		const jobs = db.select().from(abuseJobs).where(eq(abuseJobs.routeId, route!.id)).all();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			jobType: "submit_provider",
			reportId: created.reportId,
			routeId: route!.id,
			dedupeKey: `provider-submit:${route!.id.toString()}`,
		});
	});

	test("moves an unregistered direct provider route to needs_human instead of falling back to email", async () => {
		const created = await createReport();
		const [target] = await AbuseRepository.listTargets(created.reportId);
		if (!target) throw new Error("Test report has no target.");
		const route = await AbuseRepository.upsertResolvedRoute(target.id, {
			routeKey: "provider_submission:removed-provider:contact",
			providerRegistryKey: "removed-provider",
			providerDisplayName: "Removed Provider",
			routeType: "provider_submission",
			providerDefinitionVersion: "removed-v1",
			providerDefinitionHash: "b".repeat(64),
			resolverProvenance: { source: "direct_provider_dispatch_test" },
			resolutionSnapshot: { source: "direct_provider_dispatch_test" },
			status: "verified",
		});
		// This fixture supplies the resolved route directly. Retire the report's
		// automatically-created resolver job so this worker invocation exercises
		// the direct-provider job rather than performing a real resolver lookup.
		const db = await getDb();
		db.update(abuseJobs).set({ status: "completed" }).where(eq(abuseJobs.reportId, created.reportId)).run();
		await AbuseRepository.enqueueJob({
			jobType: "submit_provider",
			reportId: created.reportId,
			routeId: route.id,
			payload: {},
			dedupeKey: `provider-submit:${route.id.toString()}`,
		});

		const worker = new AbuseWorker({ owner: "direct-provider-resolution-test" });
		expect(await worker.processOne()).toBeTrue();
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "needs_human" });

		const [job] = db.select().from(abuseJobs).where(eq(abuseJobs.routeId, route.id)).all();
		expect(job).toMatchObject({ jobType: "submit_provider", status: "completed" });
	});
});

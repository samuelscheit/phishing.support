import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";

useTemporaryDatabase();

const reportPayload = {
	targets: ["example.com"],
	allegationCategory: "phishing" as const,
	description: "A credential-harvesting page impersonates the protected brand.",
	observedUrls: [{ target: "example.com", urls: ["https://login.example.com/collect"] }],
	legalBrandUrl: "https://brand.example.com/",
};

async function createRoute(params: {
	routeType?: "email" | "provider_submission";
	status?: "queued" | "verified";
} = {}) {
	const request = await validateAbuseReportRequest(reportPayload);
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	if (!target) throw new Error("Test report did not create its target.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: `provider:${created.reportId.toString()}`,
		providerRegistryKey: "test-provider",
		providerDisplayName: "Test Provider",
		routeType: params.routeType ?? "provider_submission",
		resolverProvenance: { source: "provider_execution_test" },
		resolutionSnapshot: { source: "test" },
		status: params.status ?? "queued",
	});
	return { ...created, target, route };
}

describe("provider submission durability", () => {
	test("records the direct-provider boundary exactly once and retains it as an active run", async () => {
		const context = await createRoute();
		const correlationKey = `provider-submission:${context.route.id.toString()}`;
		const execution = await AbuseRepository.beginProviderExecution({
			routeId: context.route.id,
			providerPayload: { adapter: "test_provider_submission" },
			correlationKey,
			expectedStatus: "queued",
		});
		if (!execution) throw new Error("Test provider-submission route could not be claimed.");
		expect(execution).toMatchObject({ created: true, resumed: false });
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "running" });
		expect(await AbuseRepository.getProviderRun(execution.run.id)).toMatchObject({ executionStatus: "starting" });

		const resumed = await AbuseRepository.beginProviderExecution({
			routeId: context.route.id,
			providerPayload: { adapter: "test_provider_submission" },
			correlationKey,
			expectedStatus: "queued",
		});
		expect(resumed).toMatchObject({ run: { id: execution.run.id }, created: false, resumed: true });

		expect(await AbuseRepository.prepareProviderSubmission(execution.run.id)).toBeTrue();
		expect(await AbuseRepository.prepareProviderSubmission(execution.run.id)).toBeFalse();
		expect(await AbuseRepository.getProviderRun(execution.run.id)).toMatchObject({ executionStatus: "submission_started" });
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "running" });
		expect(await AbuseRepository.getLatestActiveProviderRunForRoute(context.route.id)).toMatchObject({
			id: execution.run.id,
			executionStatus: "submission_started",
		});

		const eventTypes = (await AbuseRepository.listEvents(context.reportId)).map((event) => event.eventType);
		expect(eventTypes).toEqual(expect.arrayContaining([
			"provider_run.provider_execution_resumed",
			"provider_run.provider_submission_started",
		]));
	});

	test("refuses to mark a submission from a non-submission route or before the route is running", async () => {
		const emailContext = await createRoute({ routeType: "email" });
		const emailExecution = await AbuseRepository.beginProviderExecution({
			routeId: emailContext.route.id,
			providerPayload: { adapter: "test_email_route" },
			correlationKey: `email:${emailContext.route.id.toString()}`,
			expectedStatus: "queued",
		});
		if (!emailExecution) throw new Error("Test email route could not be claimed.");
		expect(await AbuseRepository.prepareProviderSubmission(emailExecution.run.id)).toBeFalse();
		expect(await AbuseRepository.getProviderRun(emailExecution.run.id)).toMatchObject({ executionStatus: "starting" });

		const queuedContext = await createRoute();
		const queuedRun = await AbuseRepository.createProviderRun({
			routeId: queuedContext.route.id,
			providerPayload: { adapter: "test_provider_submission" },
			correlationKey: `queued:${queuedContext.route.id.toString()}`,
			executionStatus: "starting",
		});
		expect(await AbuseRepository.prepareProviderSubmission(queuedRun.id)).toBeFalse();
		expect(await AbuseRepository.getProviderRun(queuedRun.id)).toMatchObject({ executionStatus: "starting" });
		expect(await AbuseRepository.getRoute(queuedContext.route.id)).toMatchObject({ status: "queued" });
	});

	test("claims a verified direct-provider route and settles a known provider rejection", async () => {
		const context = await createRoute({ status: "verified" });
		const execution = await AbuseRepository.beginProviderExecution({
			routeId: context.route.id,
			providerPayload: { adapter: "test_provider_submission" },
			correlationKey: `verified:${context.route.id.toString()}`,
			expectedStatus: "verified",
		});
		if (!execution) throw new Error("Verified direct-provider route could not be claimed.");
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "running" });
		expect(await AbuseRepository.prepareProviderSubmission(execution.run.id)).toBeTrue();

		expect(await AbuseRepository.settleProviderRun({
			runId: execution.run.id,
			executionStatus: "completed",
			routeStatus: "provider_rejected",
			failureReason: "The provider rejected this report through its documented API.",
		})).toBeTrue();
		expect(await AbuseRepository.getProviderRun(execution.run.id)).toMatchObject({ executionStatus: "completed" });
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "provider_rejected" });
	});

	test("settles insufficient evidence before the provider boundary is marked", async () => {
		const context = await createRoute({ status: "verified" });
		const execution = await AbuseRepository.beginProviderExecution({
			routeId: context.route.id,
			providerPayload: { adapter: "test_provider_submission" },
			correlationKey: `insufficient-evidence:${context.route.id.toString()}`,
			expectedStatus: "verified",
		});
		if (!execution) throw new Error("Verified direct-provider route could not be claimed.");
		expect(await AbuseRepository.getProviderRun(execution.run.id)).toMatchObject({ executionStatus: "starting" });

		expect(await AbuseRepository.settleProviderRun({
			runId: execution.run.id,
			executionStatus: "failed",
			routeStatus: "insufficient_evidence",
			failureReason: "No usable evidence artifact is available for this provider.",
		})).toBeTrue();
		expect(await AbuseRepository.getProviderRun(execution.run.id)).toMatchObject({ executionStatus: "failed" });
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "insufficient_evidence" });
	});
});

import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { hashStableJson } from "../security";
import {
	executeProviderSubmission,
	ProviderSubmissionUnknownExternalStateError,
} from "./submission_execution";
import {
	ProviderSubmissionRejectedError,
	type ProviderSubmissionProvider,
} from "./submission_contracts";

useTemporaryDatabase();

const reportPayload = {
	targets: ["example.com"],
	allegationCategory: "phishing" as const,
	description: "A credential-harvesting page impersonates the protected brand.",
	observedUrls: [{ target: "example.com", urls: ["https://login.example.com/collect"] }],
	legalBrandUrl: "https://brand.example.com/",
};

function testProvider(overrides: Partial<ProviderSubmissionProvider> = {}): ProviderSubmissionProvider {
	const definitionWithoutHash = {
		key: "test-provider",
		displayName: "Test Provider",
		version: "test-v1",
		exactMailboxes: ["abuse@test-provider.example"],
		supplemental: false,
	};
	return {
		definition: {
			...definitionWithoutHash,
			contentHash: hashStableJson(definitionWithoutHash),
		},
		prepareSubmission: async () => ({ outcome: "ready", payload: { adapter: "test_provider", target: "example.com" } }),
		submit: async () => ({ submittedTargets: ["example.com"] }),
		...overrides,
	};
}

async function createProviderRoute(provider: ProviderSubmissionProvider, params: { version?: string; contentHash?: string; status?: "queued" | "verified" } = {}) {
	const request = await validateAbuseReportRequest(reportPayload);
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	if (!target) throw new Error("Test report did not create its target.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: `${provider.definition.key}:${created.reportId.toString()}`,
		providerRegistryKey: provider.definition.key,
		providerDisplayName: provider.definition.displayName,
		routeType: "provider_submission",
		providerDefinitionVersion: params.version ?? provider.definition.version,
		providerDefinitionHash: params.contentHash ?? provider.definition.contentHash,
		resolverProvenance: { source: "provider_submission_execution_test" },
		resolutionSnapshot: { source: "test" },
		status: params.status ?? "verified",
	});
	return { ...created, target, route };
}

describe("provider submission execution boundary", () => {
	test("prepares once, persists the immutable payload, marks before submit, and settles success", async () => {
		let prepareCalls = 0;
		let submitCalls = 0;
		let observedRunId: bigint | undefined;
		const provider = testProvider({
			prepareSubmission: async (context) => {
				prepareCalls += 1;
				expect(context).toEqual({ routeId: expect.any(BigInt), payload: {} });
				return { outcome: "ready", payload: { adapter: "test_provider", target: "example.com", immutable: true } };
			},
			submit: async (context) => {
				submitCalls += 1;
				observedRunId = context.runId;
				expect(context.runId).toBeDefined();
				expect(context.payload).toEqual({ adapter: "test_provider", target: "example.com", immutable: true });
				expect(await AbuseRepository.getProviderRun(context.runId!)).toMatchObject({ executionStatus: "submission_started" });
				return {
					confirmationId: "provider-confirmation-1",
					confirmationText: "Provider accepted the report.",
					finalUrl: "https://provider.example/confirmation/1",
					submittedTargets: ["example.com"],
				};
			},
		});
		const { route } = await createProviderRoute(provider);

		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "submitted", runId: expect.any(BigInt) });
		expect(prepareCalls).toBe(1);
		expect(submitCalls).toBe(1);
		expect(observedRunId).toBeDefined();
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
		expect(await AbuseRepository.getProviderRun(observedRunId!)).toMatchObject({
			executionStatus: "completed",
			providerPayload: { adapter: "test_provider", target: "example.com", immutable: true },
			confirmationId: "provider-confirmation-1",
			confirmationText: "Provider accepted the report.",
			finalUrl: "https://provider.example/confirmation/1",
			submittedTargets: ["example.com"],
		});

		// A completed route is never prepared or submitted again by a stale job.
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "not_eligible" });
		expect(prepareCalls).toBe(1);
		expect(submitCalls).toBe(1);
	});

	test("keeps ephemeral preflight state out of the durable payload and disposes it after settlement", async () => {
		let preflightCalls = 0;
		let submitPreparedCalls = 0;
		let disposed = 0;
		const provider = testProvider({
			prepareExternalSubmission: async (context) => {
				preflightCalls += 1;
				expect(await AbuseRepository.getProviderRun(context.runId!)).toMatchObject({ executionStatus: "starting" });
				return {
					state: { token: "short-lived-token" },
					dispose: async () => { disposed += 1; },
				};
			},
			submitPrepared: async (context, preflight) => {
				submitPreparedCalls += 1;
				expect(await AbuseRepository.getProviderRun(context.runId!)).toMatchObject({ executionStatus: "submission_started" });
				expect(preflight.state).toEqual({ token: "short-lived-token" });
				return { submittedTargets: ["example.com"] };
			},
		});
		const { route } = await createProviderRoute(provider);

		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toMatchObject({ outcome: "submitted" });
		expect(preflightCalls).toBe(1);
		expect(submitPreparedCalls).toBe(1);
		expect(disposed).toBe(1);
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run?.providerPayload).not.toHaveProperty("token");
	});

	test("leaves a failed preflight retryable before the durable submission marker", async () => {
		let submitCalls = 0;
		const provider = testProvider({
			prepareExternalSubmission: async () => { throw new Error("Turnstile solver temporarily unavailable."); },
			submit: async () => { submitCalls += 1; return { submittedTargets: ["example.com"] }; },
		});
		const { route } = await createProviderRoute(provider);

		await expect(executeProviderSubmission({ routeId: route.id, provider })).rejects.toThrow("Turnstile solver temporarily unavailable");
		expect(submitCalls).toBe(0);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "running" });
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "starting" });

		const recoveredProvider = testProvider({
			prepareExternalSubmission: async () => ({ state: { ready: true }, dispose: async () => {} }),
			submitPrepared: async () => ({ submittedTargets: ["example.com"] }),
		});
		await expect(executeProviderSubmission({ routeId: route.id, provider: recoveredProvider })).resolves.toMatchObject({ outcome: "submitted" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
	});

	test("settles insufficient evidence before creating a run or crossing the provider boundary", async () => {
		let submitted = false;
		const provider = testProvider({
			prepareSubmission: async () => ({ outcome: "insufficient_evidence", reason: "A provider-compatible PNG artifact is required." }),
			submit: async () => { submitted = true; return { submittedTargets: ["example.com"] }; },
		});
		const { route } = await createProviderRoute(provider);

		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({
			outcome: "insufficient_evidence",
			reason: "A provider-compatible PNG artifact is required.",
		});
		expect(submitted).toBeFalse();
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "insufficient_evidence" });
		expect(await AbuseRepository.listProviderRunsForReport(route.reportId)).toEqual([]);
	});

	test("settles an explicit provider rejection without treating it as an ambiguous submit", async () => {
		const provider = testProvider({
			submit: async () => { throw new ProviderSubmissionRejectedError("Provider rejected the report as out of scope."); },
		});
		const { route } = await createProviderRoute(provider);

		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({
			outcome: "provider_rejected",
			runId: expect.any(BigInt),
			reason: "Provider rejected the report as out of scope.",
		});
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "failed", failureReason: "Provider rejected the report as out of scope." });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "provider_rejected" });
	});

	test("marks a post-marker error unknown rather than replaying the provider request", async () => {
		let submitCalls = 0;
		const provider = testProvider({
			submit: async (context) => {
				submitCalls += 1;
				expect(await AbuseRepository.getProviderRun(context.runId!)).toMatchObject({ executionStatus: "submission_started" });
				throw new Error("connection dropped after request write");
			},
		});
		const { route } = await createProviderRoute(provider);

		await expect(executeProviderSubmission({ routeId: route.id, provider })).rejects.toBeInstanceOf(ProviderSubmissionUnknownExternalStateError);
		expect(submitCalls).toBe(1);
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "unknown_external_state", failureReason: "connection dropped after request write" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "unknown_external_state" });

		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "not_eligible" });
		expect(submitCalls).toBe(1);
	});

	test("fails closed when provider acceptance cannot be durably settled after the marker", async () => {
		const provider = testProvider({ submit: async () => ({ confirmationId: "accepted-before-local-failure", submittedTargets: ["example.com"] }) });
		const { route } = await createProviderRoute(provider);
		const originalSettlement = AbuseRepository.settleProviderRun;
		(AbuseRepository as unknown as { settleProviderRun: typeof AbuseRepository.settleProviderRun }).settleProviderRun = async () => {
			throw new Error("database write unavailable");
		};
		try {
			await expect(executeProviderSubmission({ routeId: route.id, provider })).rejects.toBeInstanceOf(ProviderSubmissionUnknownExternalStateError);
		} finally {
			(AbuseRepository as unknown as { settleProviderRun: typeof AbuseRepository.settleProviderRun }).settleProviderRun = originalSettlement;
		}
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "unknown_external_state" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "unknown_external_state" });
	});

	test("fails closed on a resumed run that already crossed the durable marker or has a mismatched definition", async () => {
		let submitted = false;
		const provider = testProvider({ submit: async () => { submitted = true; return { submittedTargets: ["example.com"] }; } });
		const interrupted = await createProviderRoute(provider);
		const execution = await AbuseRepository.beginProviderExecution({
			routeId: interrupted.route.id,
			providerPayload: { adapter: "test_provider" },
			correlationKey: `provider-submission:${provider.definition.key}:${interrupted.route.id.toString()}`,
			expectedStatus: "verified",
		});
		if (!execution) throw new Error("Interrupted test run could not be created.");
		expect(await AbuseRepository.prepareProviderSubmission(execution.run.id)).toBeTrue();

		await expect(executeProviderSubmission({ routeId: interrupted.route.id, provider })).rejects.toBeInstanceOf(ProviderSubmissionUnknownExternalStateError);
		expect(submitted).toBeFalse();
		expect(await AbuseRepository.getRoute(interrupted.route.id)).toMatchObject({ status: "unknown_external_state" });

		const mismatched = await createProviderRoute(provider, { version: "old-reviewed-version" });
		await expect(executeProviderSubmission({ routeId: mismatched.route.id, provider })).resolves.toEqual({ outcome: "not_eligible" });
		expect(await AbuseRepository.getRoute(mismatched.route.id)).toMatchObject({ status: "needs_human" });
	});
});

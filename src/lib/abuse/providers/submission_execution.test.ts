import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import {
	executeProviderSubmission,
	ProviderSubmissionUnknownExternalStateError,
} from "./submission_execution";
import {
	ProviderSubmissionNeedsHumanError,
	ProviderSubmissionRejectedError,
	ProviderSubmissionRetryLaterError,
	type ProviderSubmissionProvider,
	type ProviderSubmissionSuccess,
} from "./submission_contracts";
import { findProviderReceipt } from "../worker/receipt";
import { getDb } from "../../db";
import { abuseJobs, abuseProviderRuns } from "../schema";
import { and, eq } from "drizzle-orm";
import { hashStableJson } from "../../util/hash";

useTemporaryDatabase();

const reportPayload = {
	targets: ["example.com"],
	allegationCategory: "phishing" as const,
	reporterName: "Test Reporter",
	reporterContactEmail: "reporter@example.org",
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
		verifyDraft: async () => undefined,
		submit: async () => ({ submittedTargets: ["example.com"] }),
		...overrides,
	} as ProviderSubmissionProvider;
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

	test("verifies the draft before the preflight and the marker, so a draft that no longer holds sends and marks nothing", async () => {
		const order: string[] = [];
		const provider = testProvider({
			verifyDraft: async (context) => { order.push(`verify:${(await AbuseRepository.getProviderRun(context.runId!))?.executionStatus}`); },
			prepareExternalSubmission: async () => { order.push("preflight"); return { state: {} }; },
			submitPrepared: async (context) => { order.push(`submit:${(await AbuseRepository.getProviderRun(context.runId!))?.executionStatus}`); return { submittedTargets: ["example.com"] }; },
		});
		const { route } = await createProviderRoute(provider);
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toMatchObject({ outcome: "submitted" });
		expect(order).toEqual(["verify:starting", "preflight", "submit:submission_started"]);

		// A draft that still fails verification after it was rebuilt is an ordinary retryable error before the marker.
		let sent = 0;
		const unrepairable = testProvider({
			verifyDraft: async () => { throw new Error("The persisted draft no longer matches the report."); },
			submit: async () => { sent += 1; return { submittedTargets: ["example.com"] }; },
		});
		const second = await createProviderRoute(unrepairable);
		await expect(executeProviderSubmission({ routeId: second.route.id, provider: unrepairable })).rejects.toThrow("no longer matches the report");
		expect(sent).toBe(0);
		expect(await AbuseRepository.getRoute(second.route.id)).toMatchObject({ status: "running" });
		expect(await AbuseRepository.listProviderRunsForReport(second.route.reportId)).toMatchObject([{ executionStatus: "starting" }]);
	});

	test("refreshes an interrupted pre-marker draft that no longer verifies, never after the marker", async () => {
		const stale = { adapter: "test_provider", narrativeVersion: 2 };
		const current = { adapter: "test_provider", narrativeVersion: 3 };
		const provider = testProvider({
			prepareSubmission: async () => ({ outcome: "ready", payload: stale }),
			verifyDraft: async () => undefined,
			prepareExternalSubmission: async () => { throw new Error("temporary provider preflight outage"); },
		});
		const { route } = await createProviderRoute(provider);
		await expect(executeProviderSubmission({ routeId: route.id, provider })).rejects.toThrow("temporary provider preflight outage");
		const [interrupted] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(interrupted).toMatchObject({ executionStatus: "starting", providerPayload: stale });

		let refreshCalls = 0;
		const recovered = testProvider({
			prepareSubmission: async (context) => {
				refreshCalls += 1;
				expect(context.runId).toBe(interrupted!.id);
				return { outcome: "ready", payload: current };
			},
			verifyDraft: async (context) => { if (context.payload.narrativeVersion !== 3) throw new Error("The persisted draft no longer matches the report."); },
			submit: async (context) => {
				expect(context.payload).toEqual(current);
				return { submittedTargets: ["example.com"] };
			},
		});
		await expect(executeProviderSubmission({ routeId: route.id, provider: recovered })).resolves.toMatchObject({ outcome: "submitted" });
		expect(refreshCalls).toBe(1);
		expect(await AbuseRepository.getProviderRun(interrupted!.id)).toMatchObject({ executionStatus: "completed", providerPayload: current });

		// A run that passed the marker is never verified, rebuilt or replaced.
		const marked = await createProviderRoute(provider);
		const execution = await AbuseRepository.beginProviderExecution({
			routeId: marked.route.id,
			providerPayload: stale,
			correlationKey: `provider-submission:${provider.definition.key}:${marked.route.id.toString()}`,
			expectedStatus: "verified",
		});
		expect(await AbuseRepository.prepareProviderSubmission(execution!.run.id)).toBeTrue();
		await expect(executeProviderSubmission({ routeId: marked.route.id, provider: recovered })).rejects.toBeInstanceOf(ProviderSubmissionUnknownExternalStateError);
		expect(refreshCalls).toBe(1);
		expect(await AbuseRepository.getProviderRun(execution!.run.id)).toMatchObject({ providerPayload: stale });
	});

	test("a refreshed draft that is refused settles the run for good, still before the marker", async () => {
		const provider = testProvider({
			verifyDraft: async () => { throw new Error("drifted"); },
			prepareExternalSubmission: async () => { throw new Error("must not be reached"); },
		});
		const first = provider.prepareSubmission!;
		let prepares = 0;
		provider.prepareSubmission = async (context) => (prepares++ === 0 ? first(context) : { outcome: "insufficient_evidence", reason: "the evidence is gone" });
		const { route } = await createProviderRoute(provider);
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "insufficient_evidence", reason: "the evidence is gone" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "insufficient_evidence" });
		expect(await AbuseRepository.listProviderRunsForReport(route.reportId)).toMatchObject([{ executionStatus: "failed", failureReason: "the evidence is gone" }]);
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

	test("a provider's limit releases the marker: the same run files the report once the limit lifts", async () => {
		let limited = true;
		const submitted: bigint[] = [];
		const provider = testProvider({
			submit: async (context) => {
				submitted.push(context.runId!);
				if (limited) throw new ProviderSubmissionRetryLaterError("Provider limit reached; nothing filed.", 60_000);
				return { submittedTargets: ["example.com"], confirmationId: "CASE-1" };
			},
		});
		const { route } = await createProviderRoute(provider);

		const error = await executeProviderSubmission({ routeId: route.id, provider }).catch((caught) => caught);
		expect(error).toBeInstanceOf(ProviderSubmissionRetryLaterError);
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "starting" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "running" });

		limited = false;
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toMatchObject({ outcome: "submitted" });
		expect(submitted).toEqual([run!.id, run!.id]);
		expect(await AbuseRepository.listProviderRunsForReport(route.reportId)).toHaveLength(1);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
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

	test("an ambiguous submission is looked up at its provider on a schedule and settled by the receipt it finds, never resubmitted", async () => {
		// Production 2026-11-16: Cloudflare stored report 58dd5e517c5fc535 (keychainagent.pro)
		// behind an HTTP 504; the route stayed "unknown external state".
		let submitCalls = 0;
		const lookups: Array<{ sentAt: Date; payload: Record<string, unknown> }> = [];
		let stored: ProviderSubmissionSuccess | undefined;
		const provider = testProvider({
			submit: async () => { submitCalls += 1; throw new Error("HTTP 504: Gateway time-out"); },
			findSubmission: async (context) => { lookups.push({ sentAt: context.sentAt, payload: context.payload }); return stored; },
			fetchCorrespondence: async () => ({ messages: [] }),
		});
		const providerFor = () => provider;
		const { route } = await createProviderRoute(provider);

		const before = Date.now();
		await expect(executeProviderSubmission({ routeId: route.id, provider })).rejects.toBeInstanceOf(ProviderSubmissionUnknownExternalStateError);
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		const lookupJobs = async () => (await getDb()).select().from(abuseJobs).where(and(eq(abuseJobs.routeId, route.id), eq(abuseJobs.jobType, "find_provider_receipt"))).all();
		const [first] = await lookupJobs();
		expect(first).toMatchObject({ status: "queued", runId: run!.id, dedupeKey: `find-provider-receipt:${run!.id}` });
		// A minute after the submission: a provider can list a stored report late.
		expect(first!.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(59_000);
		expect(first!.nextAttemptAt.getTime() - before).toBeLessThan(62_000);

		// The first lookup, a minute after the submission. Not listed yet: the next one
		// is queued for five minutes after the submission, and the route stays ambiguous.
		const submittedAt = new Date(Date.now() - 61_000);
		(await getDb()).update(abuseProviderRuns).set({ createdAt: submittedAt }).where(eq(abuseProviderRuns.id, run!.id)).run();
		await findProviderReceipt({ runId: run!.id, jobId: first!.id, providerFor });
		expect(lookups).toEqual([{ sentAt: submittedAt, payload: { adapter: "test_provider", target: "example.com" } }]);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "unknown_external_state" });
		(await getDb()).update(abuseJobs).set({ status: "completed" }).where(eq(abuseJobs.id, first!.id)).run();
		const successor = (await lookupJobs()).find((job) => job.status === "queued");
		const untilNext = successor!.nextAttemptAt.getTime() - submittedAt.getTime();
		expect(untilNext).toBeGreaterThan(5 * 60_000 - 2_000);
		expect(untilNext).toBeLessThan(5 * 60_000 + 2_000);

		// Listed now: the run settles with the provider's receipt and its correspondence is read.
		stored = { confirmationId: "58dd5e517c5fc535", confirmationText: "found", finalUrl: "https://provider.example/reports", submittedTargets: ["example.com"] };
		await findProviderReceipt({ runId: run!.id, jobId: successor!.id, providerFor });
		expect(await AbuseRepository.getProviderRun(run!.id)).toMatchObject({ executionStatus: "completed", confirmationId: "58dd5e517c5fc535", finalUrl: "https://provider.example/reports" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "submitted" });
		expect((await getDb()).select().from(abuseJobs).where(and(eq(abuseJobs.routeId, route.id), eq(abuseJobs.jobType, "poll_provider_correspondence"))).all()).toHaveLength(1);

		// A settled route is not looked up again, and nothing was ever submitted twice.
		await findProviderReceipt({ runId: run!.id, jobId: successor!.id, providerFor });
		expect(lookups).toHaveLength(2);
		expect(submitCalls).toBe(1);
	});

	test("receipt lookups end with their schedule, and a provider without a lookup gets none", async () => {
		const provider = testProvider({ submit: async () => { throw new Error("socket hang up"); }, findSubmission: async () => undefined });
		const { route } = await createProviderRoute(provider);
		await expect(executeProviderSubmission({ routeId: route.id, provider })).rejects.toBeInstanceOf(ProviderSubmissionUnknownExternalStateError);
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		const jobs = () => getDb().then((db) => db.select().from(abuseJobs).where(and(eq(abuseJobs.routeId, route.id), eq(abuseJobs.jobType, "find_provider_receipt"))).all());
		const [job] = await jobs();
		(await getDb()).update(abuseJobs).set({ status: "completed" }).where(eq(abuseJobs.id, job!.id)).run();
		// Two days after the submission the last lookup is past: the route stays for a person.
		(await getDb()).update(abuseProviderRuns).set({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000) }).where(eq(abuseProviderRuns.id, run!.id)).run();
		await findProviderReceipt({ runId: run!.id, jobId: job!.id, providerFor: () => provider });
		expect((await jobs()).filter((queued) => queued.status === "queued")).toHaveLength(0);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "unknown_external_state" });

		const blind = testProvider({ submit: async () => { throw new Error("socket hang up"); } });
		const { route: blindRoute } = await createProviderRoute(blind);
		await expect(executeProviderSubmission({ routeId: blindRoute.id, provider: blind })).rejects.toBeInstanceOf(ProviderSubmissionUnknownExternalStateError);
		expect((await getDb()).select().from(abuseJobs).where(and(eq(abuseJobs.routeId, blindRoute.id), eq(abuseJobs.jobType, "find_provider_receipt"))).all()).toHaveLength(0);
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

	test("settles an explicit preflight authentication failure as terminal needs_human without a marker or retry", async () => {
		let submitCalls = 0;
		let disposed = 0;
		const provider = testProvider({
			prepareExternalSubmission: async () => { throw new ProviderSubmissionNeedsHumanError("Provider account login was rejected."); },
			submitPrepared: async () => { submitCalls += 1; return { submittedTargets: ["example.com"] }; },
			submit: async () => { submitCalls += 1; return { submittedTargets: ["example.com"] }; },
		});
		const { route } = await createProviderRoute(provider);

		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({
			outcome: "needs_human",
			runId: expect.any(BigInt),
			reason: "Provider account login was rejected.",
		});
		expect(submitCalls).toBe(0);
		expect(disposed).toBe(0);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "needs_human" });
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "failed", failureReason: "Provider account login was rejected." });

		// A stale retry never re-enters the provider.
		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({ outcome: "not_eligible" });
		expect(submitCalls).toBe(0);
	});

	test("settles an explicit post-marker expired-session failure as needs_human, not unknown_external_state", async () => {
		let disposed = 0;
		const provider = testProvider({
			prepareExternalSubmission: async () => ({ state: {}, dispose: async () => { disposed += 1; } }),
			submitPrepared: async (context) => {
				expect(await AbuseRepository.getProviderRun(context.runId!)).toMatchObject({ executionStatus: "submission_started" });
				throw new ProviderSubmissionNeedsHumanError("Provider session expired; sign in again.");
			},
		});
		const { route } = await createProviderRoute(provider);

		await expect(executeProviderSubmission({ routeId: route.id, provider })).resolves.toEqual({
			outcome: "needs_human",
			runId: expect.any(BigInt),
			reason: "Provider session expired; sign in again.",
		});
		expect(disposed).toBe(1);
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "needs_human" });
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "failed", failureReason: "Provider session expired; sign in again." });
	});

	test("disposes a prepared preflight exactly once when the run is aborted right after it, and never marks", async () => {
		const controller = new AbortController();
		let disposed = 0;
		let submitCalls = 0;
		const provider = testProvider({
			prepareExternalSubmission: async () => {
				controller.abort(new Error("worker deadline"));
				return { state: {}, dispose: async () => { disposed += 1; } };
			},
			submitPrepared: async () => { submitCalls += 1; return { submittedTargets: ["example.com"] }; },
		});
		const { route } = await createProviderRoute(provider);

		await expect(executeProviderSubmission({ routeId: route.id, provider, signal: controller.signal })).rejects.toThrow("worker deadline");
		expect(disposed).toBe(1);
		expect(submitCalls).toBe(0);
		const [run] = await AbuseRepository.listProviderRunsForReport(route.reportId);
		expect(run).toMatchObject({ executionStatus: "starting" });
	});
});

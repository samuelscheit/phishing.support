import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { routeFixture } from "../providers/kit/testing";
import { AbuseRepository } from "../repository";
import { abuseEvents, abuseProviderRoutes, abuseProviderRuns, abuseReports, jobs } from "../schema";
import {
    requeueBrandRefusedLinkedRoutes,
    requeueFailedPreMarkerSubmissions,
    requeueGoDaddyRecaptchaPreflights,
} from "./failed_submission_requeue";

useTemporaryDatabase();

/** The text production stored on 2026-11-22 for the three GoDaddy routes. */
const RECAPTCHA_FAILURE =
	"GoDaddy: the page script failed (evaluate: Error: grecaptcha did not load at recaptchaTokenProbe (eval at evaluate (:337:30), <anonymous>:5:13) at async <anonymous>:361:30)";
const PROVIDERS = {
	godaddy: { mailbox: "abuse@godaddy.com", providerName: "GoDaddy" },
	tucows: { mailbox: "domainabuse@tucows.com", providerName: "Tucows" },
} as const;

let sequence = 0;

/** A provider-submission route the worker gave up on before its marker, as its retry-exhausted path leaves it. */
async function failedBeforeMarker(failure: string, provider: keyof typeof PROVIDERS = "godaddy") {
	sequence += 1;
	const { created, route } = await routeFixture({ ...PROVIDERS[provider], target: `requeue-${sequence}.example.com` });
	expect([route.routeType, route.status]).toEqual(["provider_submission", "verified"]);
	const execution = await AbuseRepository.beginProviderExecution({
		routeId: route.id,
		correlationKey: `provider-submission:${provider}:${route.id.toString()}`,
		providerPayload: { draft: true },
		expectedStatus: "verified",
	});
	if (!execution) throw new Error("Test route could not be claimed.");
	const job = await AbuseRepository.enqueueJob({
		jobType: "submit_provider",
		reportId: created.reportId,
		routeId: route.id,
		payload: {},
	});
	const db = await getDb();
	db.update(jobs).set({ status: "running", leaseOwner: "worker" }).where(eq(jobs.id, job.id)).run();
	expect(
		await AbuseRepository.failProviderSubmissionPreflight({
			jobId: job.id,
			owner: "worker",
			error: failure,
			routeStatus: "failed",
			reason: "retry_exhausted",
		}),
	).toBeTrue();
	expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "failed" });
	return { reportId: created.reportId, route, run: execution.run, job };
}

async function queuedJobs(routeId: bigint) {
	const db = await getDb();
	return db
		.select()
		.from(jobs)
		.where(eq(jobs.routeId, routeId))
		.all()
		.filter((job) => job.status === "queued");
}

describe("requeueFailedPreMarkerSubmissions", () => {
	test("the GoDaddy repair takes only GoDaddy routes failed with the grecaptcha preflight, resumes their run, once", async () => {
		const recaptcha = await failedBeforeMarker(RECAPTCHA_FAILURE);
		const otherFailure = await failedBeforeMarker("GoDaddy's portal form is no longer the PHISHING form (it renders type MALWARE).");
		const otherProvider = await failedBeforeMarker(`Tucows: ${RECAPTCHA_FAILURE}`, "tucows");

		const requeued = await requeueGoDaddyRecaptchaPreflights();
		expect(requeued).toEqual([recaptcha.route.id]);
		expect(await AbuseRepository.getRoute(recaptcha.route.id)).toMatchObject({ status: "queued" });
		expect(await AbuseRepository.getProviderRun(recaptcha.run.id)).toMatchObject({ executionStatus: "starting", failureReason: null });
		for (const untouched of [otherFailure, otherProvider]) {
			expect(await AbuseRepository.getRoute(untouched.route.id)).toMatchObject({ status: "failed" });
			expect(await AbuseRepository.getProviderRun(untouched.run.id)).toMatchObject({ executionStatus: "failed" });
			expect(await queuedJobs(untouched.route.id)).toHaveLength(0);
		}
		expect((await AbuseRepository.getReport(recaptcha.reportId))?.status).not.toBe("failed");

		const queued = await queuedJobs(recaptcha.route.id);
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({
			jobType: "submit_provider",
			retryCount: 0,
			dedupeKey: `provider-submit:${recaptcha.route.id.toString()}`,
		});
		const db = await getDb();
		const events = db.select().from(abuseEvents).where(eq(abuseEvents.routeId, recaptcha.route.id)).all();
		expect(events.find((event) => event.eventType === "provider_run.requeued")?.data).toEqual({
			from: "failed",
			to: "starting",
			reason: "page_world_recaptcha",
			previousFailure: RECAPTCHA_FAILURE,
		});
		expect(events.filter((event) => event.eventType === "route.status_changed").at(-1)?.data).toEqual({
			from: "failed",
			to: "queued",
			reason: "page_world_recaptcha_requeued",
		});

		// The submission resumes from its own run: claimed again before its marker.
		const resumed = await AbuseRepository.beginProviderExecution({
			routeId: recaptcha.route.id,
			correlationKey: `provider-submission:godaddy:${recaptcha.route.id.toString()}`,
			providerPayload: { draft: true },
			expectedStatus: "queued",
		});
		expect(resumed?.run).toMatchObject({ id: recaptcha.run.id, executionStatus: "starting" });

		// Idempotent: the route is no longer failed, so nothing is taken again.
		expect(await requeueGoDaddyRecaptchaPreflights()).toEqual([]);
		expect(await queuedJobs(recaptcha.route.id)).toHaveLength(1);
	});

	test("never takes a route whose run reached the submission marker", async () => {
		const marked = await failedBeforeMarker(RECAPTCHA_FAILURE);
		const db = await getDb();
		db.insert(abuseEvents)
			.values({
				id: BigInt(Date.now()) * 1000n + 7n,
				reportId: marked.reportId,
				routeId: marked.route.id,
				runId: marked.run.id,
				eventType: "provider_run.provider_submission_started",
				data: { from: "starting", to: "submission_started" },
			})
			.run();
		expect(await requeueGoDaddyRecaptchaPreflights()).toEqual([]);
		expect(await AbuseRepository.getRoute(marked.route.id)).toMatchObject({ status: "failed" });
		expect(db.select().from(abuseProviderRuns).where(eq(abuseProviderRuns.id, marked.run.id)).get()).toMatchObject({
			executionStatus: "failed",
		});
	});

	test("judges the latest run only, and a route that is not failed is left alone", async () => {
		const fixture = await failedBeforeMarker(RECAPTCHA_FAILURE);
		const db = await getDb();
		// A later run that failed for another reason decides.
		db.insert(abuseProviderRuns)
			.values({
				id: BigInt(Date.now()) * 1000n + 9n,
				reportId: fixture.reportId,
				routeId: fixture.route.id,
				providerPayload: { draft: true },
				payloadHash: "h",
				correlationKey: `later:${fixture.route.id.toString()}`,
				executionStatus: "failed",
				failureReason: "GoDaddy: the Cloudflare challenge was not passed within 60 s",
				createdAt: new Date(Date.now() + 60_000),
			})
			.run();
		const selection = { providerRegistryKey: "godaddy", failure: "grecaptcha did not load", reason: "test" };
		expect(await requeueFailedPreMarkerSubmissions(selection)).toEqual([]);
		expect(await requeueFailedPreMarkerSubmissions({ ...selection, failure: "challenge was not passed" })).toEqual([fixture.route.id]);
		// Now queued, it is no longer a candidate for any selection.
		expect(await requeueFailedPreMarkerSubmissions({ ...selection, failure: "challenge was not passed" })).toEqual([]);
	});
});

describe("requeueBrandRefusedLinkedRoutes", () => {
	const BRAND = "https://accounts.google.com/";

	/** A linked report whose Tucows route was refused without a run, as `settleKnownFailure` leaves it. */
	async function refusedLinked(options: { parentBrand?: string | null; reason?: string; from?: "queued" | "verified" } = {}) {
		sequence += 1;
		const parent = await routeFixture({
			...PROVIDERS.tucows,
			target: `parent-${sequence}.example.com`,
			legalBrandUrl: options.parentBrand === undefined ? BRAND : options.parentBrand,
		});
		const child = await routeFixture({ ...PROVIDERS.tucows, target: `linked-${sequence}.example.com`, legalBrandUrl: null });
		await AbuseRepository.saveArtifact({
			reportId: child.created.reportId,
			name: "original-request.json",
			kind: "original_request",
			mimeType: "application/json",
			buffer: Buffer.from(JSON.stringify({ kind: "exfiltration_backend", sourceReportId: parent.created.reportId.toString() })),
		});
		const from = options.from ?? "verified";
		const reason = options.reason ?? "tucows_requires_a_brand_domain";
		const db = await getDb();
		db.update(abuseProviderRoutes).set({ status: "insufficient_evidence" }).where(eq(abuseProviderRoutes.id, child.route.id)).run();
		db.insert(abuseEvents)
			.values({
				id: BigInt(Date.now()) * 1000n + BigInt(sequence),
				reportId: child.created.reportId,
				routeId: child.route.id,
				eventType: "route.status_changed",
				data: { from, to: "insufficient_evidence", reason },
			})
			.run();
		return { parent, child, from };
	}

	const brandOf = async (reportId: bigint) =>
		(await getDb()).select().from(abuseReports).where(eq(abuseReports.id, reportId)).get()?.legalBrandUrl;

	async function expectUntouched(child: { created: { reportId: bigint }; route: { id: bigint } }) {
		expect(await requeueBrandRefusedLinkedRoutes()).toEqual([]);
		expect(await AbuseRepository.getRoute(child.route.id)).toMatchObject({ status: "insufficient_evidence" });
		expect(await brandOf(child.created.reportId)).toBeNull();
		expect(await queuedJobs(child.route.id)).toHaveLength(0);
	}

	test("a refused linked route inherits its source's brand and goes back to the status it was refused from, once", async () => {
		const { child, from } = await refusedLinked();
		expect(await requeueBrandRefusedLinkedRoutes()).toEqual([child.route.id]);
		expect(await brandOf(child.created.reportId)).toBe(BRAND);
		expect(await AbuseRepository.getRoute(child.route.id)).toMatchObject({ status: from });
		const queued = await queuedJobs(child.route.id);
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({ jobType: "submit_provider", dedupeKey: `provider-submit:${child.route.id.toString()}` });
		const db = await getDb();
		const events = db.select().from(abuseEvents).where(eq(abuseEvents.reportId, child.created.reportId)).all();
		expect(events.find((event) => event.eventType === "report.legal_brand_inherited")?.data).toMatchObject({ legalBrandUrl: BRAND });
		expect(events.filter((event) => event.eventType === "route.status_changed").at(-1)?.data).toEqual({
			from: "insufficient_evidence",
			to: from,
			reason: "linked_brand_inherited",
		});

		expect(await requeueBrandRefusedLinkedRoutes()).toEqual([]);
		expect(await queuedJobs(child.route.id)).toHaveLength(1);
	});

	test("a route refused from queued goes back to queued", async () => {
		const { child } = await refusedLinked({ from: "queued" });
		expect(await requeueBrandRefusedLinkedRoutes()).toEqual([child.route.id]);
		expect(await AbuseRepository.getRoute(child.route.id)).toMatchObject({ status: "queued" });
	});

	test("skips a route that has a run", async () => {
		const { child } = await refusedLinked();
		const db = await getDb();
		db.insert(abuseProviderRuns)
			.values({
				id: BigInt(Date.now()) * 1000n + 11n,
				reportId: child.created.reportId,
				routeId: child.route.id,
				providerPayload: { draft: true },
				payloadHash: "h",
				correlationKey: `run:${child.route.id.toString()}`,
				executionStatus: "failed",
			})
			.run();
		await expectUntouched(child);
	});

	test("skips a route whose source has no brand", async () => {
		await expectUntouched((await refusedLinked({ parentBrand: null })).child);
	});

	test("skips a refusal that is not about the brand", async () => {
		await expectUntouched((await refusedLinked({ reason: "tucows_requires_a_screenshot" })).child);
	});
});

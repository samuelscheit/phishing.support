import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { jobs } from "../schema";
import { buildExfiltrationBackendRequest } from "../../exfiltration/reporting";
import { stableJson } from "../../util/hash";
import { validateAbuseReportRequest } from "../contracts";
import { buildGenericProviderFormPayload } from "../portal/form_task";
import { AbuseRepository } from "../repository";
import { genericPortalCorrelationKey } from "./portal";
import { requeueGenericPortalRun } from "./portal_requeue";

useTemporaryDatabase();

// Exfiltration reports carry an idempotency key, which needs the tracking secret.
const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-bytes-long"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

const DOMAIN = "squarespace.com";
const ENTRY_URL = "https://support.squarespace.com/hc/en-us/requests/new?ticket_form_id=23532118441357";
const TARGET = "zealousvoice.com";
const OBSERVED_URL = "https://zealousvoice.com/Mortage/Ins";
const SCREENSHOT = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 5)]);
const QUESTION = "The verified phishing report form requires an attached screenshot of the abusive page as visual evidence, but no file was provided and you instructed me not to upload files.";

/** Production's Squarespace run: it opened the form, typed the contact email, and asked for the screenshot it did not have. */
const NEEDS_INPUT_STEPS = [
	{ step: 1, actions: [{ tool: "click", ok: false, args: { ref: "e16" } }] },
	{ step: 2, actions: [{ tool: "navigate", ok: true, args: { url: ENTRY_URL } }] },
	{ step: 3, actions: [{ tool: "type", ok: true, args: { ref: "e12", submit: false, text: "support@phishing.support" } }] },
	{ step: 4, actions: [{ tool: "needs_input", ok: true, args: { question: QUESTION } }] },
];

const GAVE_UP = "Unable to attach the required evidence screenshot: the form exposes only an unreferenced attachment drop area, with no usable file-input control. I did not submit the report.";

/** Production's second Squarespace run: it dismissed the cookie banner, opened the form, filled it, clicked around the attachment area, tabbed, and gave up. */
const GAVE_UP_STEPS = [
	{ step: 3, actions: [{ tool: "click", ok: true, args: { ref: "e3", force: true } }] },
	{ step: 5, actions: [{ tool: "click", ok: true, args: { ref: "e16", force: true } }] },
	{ step: 6, actions: [{ tool: "type", ok: true, args: { ref: "e7", submit: false, text: "support@phishing.support" } }] },
	{ step: 12, actions: [{ tool: "click", ok: true, args: { ref: "e16", force: true } }] },
	{ step: 13, actions: [{ tool: "press", ok: true, args: { key: "Tab" } }] },
	{ step: 40, actions: [{ tool: "fail", ok: true, args: { reason: GAVE_UP } }] },
];
const REVIEW = "Zendesk posts the form by navigation; the run ended on /requests/new and no confirmation mail arrived.";

let submissionIds = 0n;

/** The confirmed page's report with its screenshot, and the exfiltration report against the backend found on it (without one, as such reports used to be made). */
async function exfiltrationCase(options: { pageScreenshot?: boolean } = {}) {
	const pageRequest = await validateAbuseReportRequest({ targets: ["indemnity-insurance.pages.dev"], allegationCategory: "phishing", description: "Confirmed phishing page." });
	const page = await AbuseRepository.createReport({ request: pageRequest, reporter: {} });
	await AbuseRepository.saveArtifact({ reportId: page.reportId, name: "website.png", kind: "user_evidence_original", mimeType: "image/png", buffer: SCREENSHOT });
	const request = buildExfiltrationBackendRequest({
		submissionId: ++submissionIds,
		sourceReportId: page.reportId,
		backend: { kind: "domain", key: `domain:${TARGET}`, endpointUrl: OBSERVED_URL, hostname: TARGET, method: "POST", matchedCanaries: ["email"], request: { timestamp: "2026-11-20T21:25:22.993Z", method: "POST", url: OBSERVED_URL } },
		pageUrl: "https://indemnity-insurance.pages.dev/",
		observedAt: new Date("2026-11-20T21:25:22.993Z"),
		...(options.pageScreenshot ? { pageScreenshot: { buffer: SCREENSHOT, mimeType: "image/png" as const } } : {}),
	});
	return AbuseRepository.createReport({ request, reporter: {} });
}

/**
 * A generic-form route the agent stopped, settled as the worker settles it,
 * with the task record the worker stores: `needs_input` (route `needs_human`)
 * or its own `fail` (route `failed`).
 */
async function stoppedRoute(options: { stop?: "needs_input" | "gave_up"; steps?: unknown[]; recordStatus?: string; confirmationId?: string; reportId?: bigint } = {}) {
	const gaveUp = options.stop === "gave_up";
	const reportId = options.reportId ?? (await exfiltrationCase()).reportId;
	const [target] = await AbuseRepository.listTargets(reportId);
	const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
		routeKey: `email:${DOMAIN}`,
		providerRegistryKey: `email:${DOMAIN}`,
		providerDisplayName: "Squarespace",
		routeType: "email",
		verifiedEmail: `abuse-complaints@${DOMAIN}`,
		resolverProvenance: { source: "requeue_test" },
		resolutionSnapshot: { source: "test" },
		status: "queued",
	});
	expect(await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "queued", to: "escalating_to_portal" })).toBeTrue();
	const providerPayload = buildGenericProviderFormPayload({
		entryUrl: ENTRY_URL,
		allowedDomains: [DOMAIN],
		target: TARGET,
		allegationCategory: "phishing",
		description: "This backend received synthetic data entered into the confirmed phishing page.",
		observedUrls: [OBSERVED_URL],
		reporter: { name: "Phishing Support", organization: "Phishing Support", website: "https://phishing.support", email: "support@phishing.support" },
		observedAt: new Date("2026-11-20T21:25:22.993Z"),
		evidence: [],
	});
	const correlationKey = await genericPortalCorrelationKey(route, ENTRY_URL);
	const execution = await AbuseRepository.beginProviderExecution({ routeId: route.id, correlationKey, providerPayload, expectedStatus: "escalating_to_portal" });
	const run = execution!.run;
	expect(await AbuseRepository.startBrowserTask({ runId: run.id, fabricSessionId: "browser-session_test" })).toBeTrue();
	await AbuseRepository.saveArtifact({
		reportId,
		routeId: route.id,
		runId: run.id,
		name: `browser-task-${run.id.toString()}.json`,
		kind: "browser_task_record",
		mimeType: "application/json",
		buffer: Buffer.from(stableJson(gaveUp
			? { status: options.recordStatus ?? "failed", summary: GAVE_UP, steps: options.steps ?? GAVE_UP_STEPS }
			: { status: options.recordStatus ?? "needs_input", summary: QUESTION, question: QUESTION, steps: options.steps ?? NEEDS_INPUT_STEPS }), "utf8"),
	});
	const routeStatus = gaveUp ? "failed" : "needs_human";
	await AbuseRepository.settleProviderRun({
		runId: run.id,
		executionStatus: options.confirmationId ? "completed" : "failed",
		routeStatus,
		failureReason: gaveUp ? `failed: ${GAVE_UP}` : `The agent needs input: ${QUESTION}`,
		...(options.confirmationId ? { confirmationId: options.confirmationId } : {}),
		routeData: { reason: gaveUp ? "browser_task_gave_up" : "browser_task_needs_input" },
	});
	expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: routeStatus });
	return { reportId, route, run, correlationKey };
}

const requeueEvents = async (reportId: bigint) => (await AbuseRepository.listEvents(reportId))
	.filter((event) => event.eventType === "route.status_changed" && event.data?.to === "escalating_to_portal" && event.data?.reason === "operator_requeue_generic_portal");

describe("requeueing a generic provider-form route the agent stopped without submitting", () => {
	test("sends the route back to the same verified form with the page's screenshot and a fresh run key", async () => {
		const { reportId, route, run, correlationKey } = await stoppedRoute();
		expect(correlationKey).toMatch(/^generic-portal:\d+:[a-f0-9]{24}$/);
		const outcome = await requeueGenericPortalRun(route.id);
		if (!outcome.requeued) throw new Error(`not requeued: ${outcome.reason}`);
		const { backfilledArtifactId } = outcome;
		expect(backfilledArtifactId).toMatch(/^\d+$/);
		expect(outcome).toMatchObject({ runId: run.id.toString(), entryUrl: ENTRY_URL });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "escalating_to_portal" });
		expect((await requeueEvents(reportId)).map((event) => event.data)).toEqual([{ from: "needs_human", to: "escalating_to_portal", reason: "operator_requeue_generic_portal", providerLink: ENTRY_URL }]);

		const queuedJobs = (await getDb()).select().from(jobs).where(eq(jobs.reportId, reportId)).all();
		expect(queuedJobs.filter((job) => job.jobType === "run_portal")).toHaveLength(1);
		expect(queuedJobs.find((job) => job.jobType === "run_portal")).toMatchObject({ status: "queued", routeId: route.id, dedupeKey: `generic-portal:${route.id.toString()}`, payload: { providerLink: ENTRY_URL, requeuedFromRunId: run.id.toString() } });

		// The backend's report now carries the confirmed page's screenshot, as new ones do from the start.
		const evidence = await AbuseRepository.listArtifacts(reportId, ["user_evidence_original"]);
		const backfilled = evidence.find((artifact) => artifact.id.toString() === backfilledArtifactId);
		expect(backfilled).toMatchObject({ name: "lure-page.png", mimeType: "image/png", metadata: { source: "source_report_screenshot_backfill" } });
		expect(Buffer.from(backfilled!.blob).equals(SCREENSHOT)).toBeTrue();

		// The new escalation gets its own run rather than finding the failed one.
		const next = await genericPortalCorrelationKey(route, ENTRY_URL);
		expect(next).toBe(`${correlationKey}:2`);
		const execution = await AbuseRepository.beginProviderExecution({ routeId: route.id, correlationKey: next, providerPayload: { adapter: "generic_verified_provider_form" }, expectedStatus: "escalating_to_portal" });
		expect(execution).toMatchObject({ created: true, run: { executionStatus: "starting" } });
		expect(execution!.run.id).not.toBe(run.id);

		// It is one-off: a second call finds the route already back at the form.
		expect(await requeueGenericPortalRun(route.id)).toEqual({ requeued: false, reason: "route_status_running" });
		expect((await AbuseRepository.listArtifacts(reportId, ["user_evidence_original"])).filter((artifact) => artifact.mimeType === "image/png")).toHaveLength(1);
	});

	test("a run the agent gave up after clicking is requeued only with the operator's review, which the audit keeps", async () => {
		const { reportId } = await exfiltrationCase({ pageScreenshot: true });
		const { route, run, correlationKey } = await stoppedRoute({ stop: "gave_up", reportId });
		expect(await requeueGenericPortalRun(route.id)).toEqual({ requeued: false, reason: "task_record_shows_possible_submission" });
		expect(await requeueGenericPortalRun(route.id, { noSubmissionReview: "  " })).toEqual({ requeued: false, reason: "task_record_shows_possible_submission" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "failed" });

		const outcome = await requeueGenericPortalRun(route.id, { noSubmissionReview: ` ${REVIEW} ` });
		expect(outcome).toEqual({ requeued: true, runId: run.id.toString(), entryUrl: ENTRY_URL, jobId: expect.stringMatching(/^\d+$/) });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "escalating_to_portal" });
		expect((await requeueEvents(reportId)).map((event) => event.data)).toEqual([{ from: "failed", to: "escalating_to_portal", reason: "operator_requeue_generic_portal", providerLink: ENTRY_URL, noSubmissionReview: REVIEW }]);
		expect(await genericPortalCorrelationKey(route, ENTRY_URL)).toBe(`${correlationKey}:2`);
		expect(await requeueGenericPortalRun(route.id, { noSubmissionReview: REVIEW })).toEqual({ requeued: false, reason: "route_status_escalating_to_portal" });
	});

	test("a run the agent gave up without any possibly-submitting action needs no review", async () => {
		const { route } = await stoppedRoute({ stop: "gave_up", steps: [GAVE_UP_STEPS[2], GAVE_UP_STEPS[5]] });
		expect(await requeueGenericPortalRun(route.id)).toMatchObject({ requeued: true });
	});

	test.each([
		["ended in an error rather than the agent's own fail", { stop: "gave_up" as const, steps: [{ step: 1, actions: [{ tool: "click", ok: false }] }] }],
		["recorded another status", { stop: "gave_up" as const, recordStatus: "step_limit" }],
	])("refuses a failed run that %s", async (_label, options) => {
		const { route } = await stoppedRoute(options);
		expect(await requeueGenericPortalRun(route.id, { noSubmissionReview: REVIEW })).toEqual({ requeued: false, reason: "task_record_not_agent_stop" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "failed" });
	});

	test("a report that already has its screenshot is requeued without a copy", async () => {
		const { reportId } = await exfiltrationCase({ pageScreenshot: true });
		const { route } = await stoppedRoute({ reportId });
		const outcome = await requeueGenericPortalRun(route.id);
		expect(outcome).toMatchObject({ requeued: true });
		expect(outcome).not.toHaveProperty("backfilledArtifactId");
		expect((await AbuseRepository.listArtifacts(reportId, ["user_evidence_original"])).map((artifact) => artifact.name)).toEqual(["exfiltration-evidence.json", "lure-page.png"]);
	});

	test.each([
		["a successful click", [{ step: 1, actions: [{ tool: "click", ok: true, args: { ref: "e9" } }] }]],
		["a key press", [{ step: 1, actions: [{ tool: "press", ok: true, args: { key: "Enter" } }] }]],
		["typing that submits", [{ step: 1, actions: [{ tool: "type", ok: true, args: { ref: "e1", text: "x", submit: true } }] }]],
		["a step without its actions", [{ step: 1 }]],
	])("refuses a run whose record shows %s, which may have sent the form", async (_label, steps) => {
		const { route } = await stoppedRoute({ steps });
		expect(await requeueGenericPortalRun(route.id)).toEqual({ requeued: false, reason: "task_record_shows_possible_submission" });
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "needs_human" });
	});

	test("a record with a step missing its actions is refused even with a review", async () => {
		const { route } = await stoppedRoute({ steps: [{ step: 1 }] });
		expect(await requeueGenericPortalRun(route.id, { noSubmissionReview: REVIEW })).toEqual({ requeued: false, reason: "task_record_shows_possible_submission" });
	});

	test("refuses a run that did not end in the agent's stop, or that reported a submission", async () => {
		const done = await stoppedRoute({ recordStatus: "done" });
		expect(await requeueGenericPortalRun(done.route.id)).toEqual({ requeued: false, reason: "task_record_not_agent_stop" });
		const confirmed = await stoppedRoute({ confirmationId: "SQ-1" });
		expect(await requeueGenericPortalRun(confirmed.route.id)).toEqual({ requeued: false, reason: "latest_run_not_agent_stop" });
		expect(await AbuseRepository.getRoute(confirmed.route.id)).toMatchObject({ status: "needs_human" });
	});

	test("refuses a route that is missing, neither needs_human nor failed, or whose latest run is not a generic form run", async () => {
		expect(await requeueGenericPortalRun(1n)).toEqual({ requeued: false, reason: "route_missing" });
		const { reportId } = await exfiltrationCase();
		const [target] = await AbuseRepository.listTargets(reportId);
		const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
			routeKey: "email:other.example", providerRegistryKey: "email:other.example", providerDisplayName: "Other", routeType: "email",
			verifiedEmail: "abuse@other.example", resolverProvenance: { source: "t" }, resolutionSnapshot: { source: "t" }, status: "queued",
		});
		expect(await requeueGenericPortalRun(route.id)).toEqual({ requeued: false, reason: "route_status_queued" });
		const execution = await AbuseRepository.beginProviderExecution({ routeId: route.id, correlationKey: `email-run:${route.id.toString()}`, providerPayload: { adapter: "email" }, expectedStatus: "queued" });
		await AbuseRepository.settleProviderRun({ runId: execution!.run.id, executionStatus: "failed", routeStatus: "needs_human", failureReason: "The agent needs input: x" });
		expect(await requeueGenericPortalRun(route.id)).toEqual({ requeued: false, reason: "latest_run_not_generic_portal" });
	});
});

import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { getReportsByIds } from "../../submissions/abuse_details";
import { nextStep, plannedStepText, routeStanding, routeTimeline, untilText } from "../../submissions/report_view";
import { AbuseRepository } from "../repository";
import { abuseEvents, abuseProviderRoutes, abuseProviderRuns, abuseReports, abuseTargets, jobs } from "../schema";
import { ESCALATION_ADVANCED_EVENT, ESCALATION_EVENT, ESCALATION_HELD_EVENT, escalationJobKey } from "./ladder";
import { pendingEscalationSteps } from "./policy";
import { openEscalationSteps, sendEscalationStepNow, skipEscalationStep, upcomingEscalationSteps } from "./manual";
import { escalationState, scheduleEscalation, type EscalationDependencies } from "./run";
import { day, DOMAIN, relay, reported, SENT, site, URL_, work } from "./run.fixtures";

useTemporaryDatabase();

const PASSWORD = "operator-password-for-escalation-tests";
const originals = { secret: process.env.ABUSE_TRACKING_TOKEN_SECRET, password: process.env.OPERATOR_PASSWORD };
beforeAll(() => {
	process.env.ABUSE_TRACKING_TOKEN_SECRET = "escalation-test-secret-32-bytes-long!!";
	process.env.OPERATOR_PASSWORD = PASSWORD;
});
afterAll(() => {
	for (const [name, value] of [["ABUSE_TRACKING_TOKEN_SECRET", originals.secret], ["OPERATOR_PASSWORD", originals.password]] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

const view = async (reportId: bigint, now: Date) => (await getReportsByIds([reportId], now))[0]!;
const planned = (steps: ReadonlyArray<{ step: string; at: Date; to?: { address: string } }>) => steps.map((step) => `${step.step}@${step.at.toISOString()}${step.to ? `>${step.to.address}` : ""}`);
const queued = async (targetId: bigint) => (await getDb()).select().from(jobs).where(eq(jobs.dedupeKey, escalationJobKey(targetId))).all().filter((job) => job.status === "queued").map((job) => job.nextAttemptAt);
const taken = async (reportId: bigint) => (await AbuseRepository.listEvents(reportId)).filter((event) => event.eventType === ESCALATION_EVENT).map((event) => `${(event.data as { step: string }).step}${event.routeId ? `@${event.routeId}` : ""}:${(event.data as { action: string }).action}`);
const kit = (at: Date, send: EscalationDependencies["send"]): EscalationDependencies => ({ verify: { site: { ...site("kit"), now: () => at }, isShared: async () => false }, send, providerFor: () => undefined, countryOf: async () => "NL", now: () => at });

/** A reported site whose escalation job liveness queued a day after the report. */
async function onLadder() {
	const reported_ = await reported();
	await scheduleEscalation({ reportId: reported_.reportId, targetId: reported_.targetId }, day(1));
	return reported_;
}

describe("the planned escalation steps on the case page", () => {
	test("only while the escalation job is queued: the job is what takes them", async () => {
		const { reportId, targetId } = await reported();
		const before = await view(reportId, day(1));
		expect(before.routes.flatMap((route) => route.escalation)).toEqual([]);
		expect(before.siteEscalation).toEqual([]);
		await scheduleEscalation({ reportId, targetId }, day(1));
		expect((await view(reportId, day(1))).routes.flatMap((route) => route.escalation)).not.toEqual([]);
	});

	test("each route's next steps with whom they reach and what the follow-up says; the site's steps apart", async () => {
		const { reportId, targetId, host, registrar } = await onLadder();
		const report = await view(reportId, day(1));
		const hostRoute = report.routes.find((route) => route.id === host)!;
		expect(planned(hostRoute.escalation)).toEqual([
			`follow_up@${day(2).toISOString()}>abuse@hosting.example`,
			`next_contact@${day(4).toISOString()}>abuse@parent-net.example`,
			`upstream@${day(5).toISOString()}>noc@transit.example`,
		]);
		expect(hostRoute.escalation[0]).toMatchObject({ key: `route:${host}:1`, targetId, advanced: false, due: false });
		expect(hostRoute.escalation[1]!.to).toEqual({ name: "Parent Net", address: "abuse@parent-net.example" });
		expect(hostRoute.escalation[2]!.to).toEqual({ name: "Transit Carrier", address: "noc@transit.example" });
		// What the follow-up will say, with the check that runs right before it as a placeholder.
		const draft = hostRoute.escalation[0]!.draft!;
		expect(draft).toContain(`On 20 Nov 2026 10:00 UTC we reported the phishing page at ${URL_}`);
		expect(draft).toContain("[Our check of the site right before sending:");
		expect(draft).toContain("Hosting: 203.0.113.10 (AS64500 EXAMPLE-HOSTING)");
		expect(draft).toContain("Impersonated brand: PayPal");
		expect(draft).toMatch(/Case with screenshots, captures and timestamps: \S+\/submissions\/\d+/);
		// The registrar's form takes no follow-up and has no further contact: its steps would reach no one.
		expect(report.routes.find((route) => route.id === registrar)!.escalation).toEqual([]);
		expect(planned(report.siteEscalation)).toEqual([`oversight@${day(7).toISOString()}`, `exhausted@${day(14).toISOString()}`]);
		expect(report.viewedAt).toEqual(day(1));
	});

	test("the Next line names the follow-up instead of claiming nothing is planned; the timeline ends with it", async () => {
		const { reportId, host } = await onLadder();
		const report = await view(reportId, day(1));
		const hostRoute = report.routes.find((route) => route.id === host)!;
		const name = hostRoute.organisation;
		expect(nextStep(hostRoute, routeStanding(hostRoute), report.createdAt)).toBe(`Follow-up to ${name} at 22 Nov 10:00 UTC if it hasn't acted.`);
		const last = routeTimeline(hostRoute, report.routes).at(-1)!;
		expect(last).toMatchObject({ kind: "planned", at: day(2), step: { step: "follow_up" } });
		expect(last.kind === "planned" && last.text).toEqual({
			label: "Follow-up",
			heading: "Follow-up planned",
			condition: `if ${name} hasn't acted`,
			sentence: `We'll write to ${name} again at abuse@hosting.example, on its own report, with proof that the site still serves the reported content.`,
			notes: ["It happens only if a check right before then finds the site still serving the reported content."],
		});
		// Past its time and not taken yet: due.
		const late = (await view(reportId, new Date(day(2).getTime() + 3 * 3_600_000))).routes.find((route) => route.id === host)!;
		expect(late.escalation[0]).toMatchObject({ step: "follow_up", due: true });
		expect(untilText(late.escalation[0]!.at, new Date(day(2).getTime() + 3 * 3_600_000))).toBe("3h overdue");
		expect(nextStep(late, routeStanding(late), report.createdAt)).toBe(`Follow-up to ${name} is due.`);
		// Escalations name whom they reach.
		const skipped = { ...hostRoute, escalation: hostRoute.escalation.slice(1) };
		expect(nextStep(skipped, routeStanding(skipped), report.createdAt)).toBe(`Escalation to Parent Net at 24 Nov 10:00 UTC if ${name} hasn't acted.`);
		// The site's steps in words.
		expect(plannedStepText(report.siteEscalation[0]!)).toMatchObject({ label: "Oversight", heading: "Escalation to oversight bodies planned", condition: "if no provider has acted" });
	});

	test("a hold shows when the ladder looks again; the hosting the site left plans nothing; a month after the report nothing is planned", async () => {
		const { reportId, targetId, host } = await onLadder();
		const { send } = relay();
		await work(targetId, { verify: { site: site("gone"), isShared: async () => false }, send, now: () => day(2) });
		const held = (await view(reportId, day(2))).routes.find((route) => route.id === host)!.escalation[0]!;
		expect(held).toMatchObject({ step: "follow_up", at: day(3), heldUntil: day(3), due: false });
		expect(plannedStepText(held, "Example Hosting", SENT).notes[0]).toBe("On hold until 23 Nov 10:00 UTC: our last check did not find the reported content.");

		await AbuseRepository.appendEvent({ reportId, targetId, eventType: "site.host_moved", data: {
			key: `${targetId}->AS64999`, targetId: targetId.toString(), at: day(2).toISOString(), since: SENT.toISOString(), kind: "new_network",
			from: { name: "EXAMPLE-HOSTING", asn: 64500, addresses: ["203.0.113.10"] }, to: { name: "OTHER-NET", asn: 64999, addresses: ["198.51.100.7"] },
			content: "served", evidence: { url: URL_, state: "online", httpStatus: 200, kitFiles: [] },
		} });
		const moved = await view(reportId, day(2));
		expect(moved.routes.flatMap((route) => route.escalation)).toEqual([]);
		expect(moved.siteEscalation.map((step) => step.step)).toEqual(["oversight", "exhausted"]);
		expect((await view(reportId, day(30.1))).siteEscalation).toEqual([]);
	});
});

describe("the operator's upcoming escalation steps", () => {
	test("lists the next step of each route and of the site, soonest first, with the case", async () => {
		const { reportId, targetId, host } = await onLadder();
		const mine = (await upcomingEscalationSteps(day(1))).filter((step) => step.targetId === targetId.toString());
		expect(mine.map((step) => `${step.step} ${step.provider ?? "site"} ${step.at}`)).toEqual([
			`follow_up ${(await view(reportId, day(1))).routes.find((route) => route.id === host)!.organisation} ${day(2).toISOString()}`,
			`oversight site ${day(7).toISOString()}`,
		]);
		expect(mine[0]).toMatchObject({ key: `route:${host}:1`, target: DOMAIN, due: false, advanced: false, to: { address: "abuse@hosting.example" }, caseHref: expect.stringMatching(/^\/submissions\/\d+$/) });
	});

	test("Skip records the step as taken: the ladder moves on, the job never sends it, and skipping again is refused", async () => {
		const { reportId, targetId, host } = await onLadder();
		await skipEscalationStep(targetId, `route:${host}:1`, day(1));
		await expect(skipEscalationStep(targetId, `route:${host}:1`, day(1))).rejects.toThrow("taken or skipped already");
		await expect(sendEscalationStepNow(targetId, `route:${host}:1`, day(1))).rejects.toThrow("taken or skipped already");
		const next = (await upcomingEscalationSteps(day(1))).find((step) => step.targetId === targetId.toString() && step.provider);
		expect(next).toMatchObject({ step: "next_contact", to: { address: "abuse@parent-net.example" }, at: day(4).toISOString() });

		const { sent, send } = relay();
		for (const at of [day(2), day(4)]) await work(targetId, kit(at, send));
		expect(sent).toEqual([]);
		expect(await taken(reportId)).toEqual([`follow_up@${host}:skipped`, expect.stringMatching(/^follow_up@\d+:no_channel$/), `next_contact@${host}:reported`, expect.stringMatching(/^next_contact@\d+:no_contact$/)]);

		// A skipped decision never waits for the operator.
		await skipEscalationStep(targetId, "site:5", day(4));
		for (const at of [day(5), day(7), day(14)]) await work(targetId, kit(at, send));
		expect((await openEscalationSteps()).filter((step) => step.reportId === reportId.toString()).map((step) => step.kind)).toEqual(["icann_complaint"]);
		expect(await taken(reportId)).not.toContain("exhausted:needs_human");
	});

	test("Send now takes exactly that step early, after the job's check that the site still serves it", async () => {
		const { reportId, targetId, host } = await onLadder();
		await sendEscalationStepNow(targetId, `route:${host}:2`, day(1));
		expect((await AbuseRepository.listEvents(reportId)).filter((event) => event.eventType === ESCALATION_ADVANCED_EVENT).map((event) => event.data)).toEqual([{ level: 2, step: "next_contact", at: day(1).toISOString() }]);
		await expect(sendEscalationStepNow(targetId, `route:${host}:2`, day(1))).rejects.toThrow("is due and goes out with the next run");
		expect(await queued(targetId)).toEqual([day(1)]);
		expect((await view(reportId, day(1))).routes.find((route) => route.id === host)!.escalation[0]).toMatchObject({ step: "next_contact", at: day(1), advanced: true, due: true });

		const { sent, send } = relay();
		await work(targetId, kit(day(1), send));
		// Only the step brought forward: the follow-up keeps its own time.
		expect(await taken(reportId)).toEqual([`next_contact@${host}:reported`]);
		expect(sent).toEqual([]);
		expect(await queued(targetId)).toEqual([day(2)]);
		await expect(skipEscalationStep(targetId, `route:${host}:2`, day(1))).rejects.toThrow("taken or skipped already");
	});

	test("Send now lifts a hold, and the step still waits for the site to serve the reported content", async () => {
		const { reportId, targetId, host } = await onLadder();
		const { sent, send } = relay();
		await work(targetId, { verify: { site: site("gone"), isShared: async () => false }, send, now: () => day(2) });
		expect(await queued(targetId)).toEqual([day(3)]);
		const now = new Date(day(2).getTime() + 3_600_000);
		await sendEscalationStepNow(targetId, `route:${host}:1`, now);
		expect(await queued(targetId)).toEqual([now]);
		// Gone again: held again, and the operator may send it now once more.
		await work(targetId, { verify: { site: site("gone"), isShared: async () => false }, send, now: () => now });
		expect(await taken(reportId)).toEqual([]);
		await sendEscalationStepNow(targetId, `route:${host}:1`, now);
		await work(targetId, kit(now, send));
		expect(sent.map((mail) => mail.recipient)).toEqual(["abuse@hosting.example"]);
		expect(await taken(reportId)).toContain(`follow_up@${host}:followed_up`);
	});

	test("an unknown site or step is refused", async () => {
		const { targetId } = await onLadder();
		await expect(sendEscalationStepNow(999n, "site:4", day(1))).rejects.toThrow("not on an escalation ladder");
		await expect(skipEscalationStep(targetId, "route:1:1", day(1))).rejects.toThrow("no longer planned");
	});

	test("while the job runs the operator is asked to wait, and a step skipped meanwhile is not taken by it", async () => {
		const { reportId, targetId, host, registrar } = await onLadder();
		const { sent, send } = relay();
		const checked = site("kit");
		let refusal: string | undefined;
		const fetch = async (...args: Parameters<NonNullable<typeof checked>["fetch"]>) => {
			// The job read its plan before this check, which can take minutes.
			refusal ??= await skipEscalationStep(targetId, `route:${host}:1`, day(2)).then(() => "accepted", (error: Error) => error.message);
			// A skip that slipped in right as the job started.
			if (!(await AbuseRepository.listEvents(reportId)).some((event) => event.eventType === ESCALATION_EVENT)) {
				await AbuseRepository.appendEvent({ reportId, targetId, routeId: host, eventType: ESCALATION_EVENT, data: { level: 1, step: "follow_up", action: "skipped", skipped: true } });
			}
			return checked!.fetch(...args);
		};
		await work(targetId, { ...kit(day(2), send), verify: { site: { ...checked, fetch, now: () => day(2) }, isShared: async () => false } });
		expect(refusal).toBe("This site's escalation is running right now; try again in a few minutes.");
		expect(sent).toEqual([]);
		expect(await taken(reportId)).toEqual([`follow_up@${host}:skipped`, `follow_up@${registrar}:no_channel`]);
		// One escalation of a site at a time, also its successor.
		expect((await getDb()).select().from(jobs).where(eq(jobs.dedupeKey, escalationJobKey(targetId))).all().map((job) => job.serialKey)).toEqual([escalationJobKey(targetId), escalationJobKey(targetId)]);
	});

	test("Send now is refused exactly when the step shows as due; one held past its time is brought back and then due", async () => {
		const { reportId, targetId, host } = await onLadder();
		const late = new Date(day(2).getTime() + 3_600_000);
		const followUp = async (now: Date) => (await view(reportId, now)).routes.find((route) => route.id === host)!.escalation[0]!;
		expect(await followUp(late)).toMatchObject({ due: true, advanced: false });
		await expect(sendEscalationStepNow(targetId, `route:${host}:1`, late)).rejects.toThrow("is due and goes out with the next run");
		expect((await AbuseRepository.listEvents(reportId)).some((event) => event.eventType === ESCALATION_ADVANCED_EVENT)).toBe(false);

		const { send } = relay();
		await work(targetId, { verify: { site: site("gone"), isShared: async () => false }, send, now: () => day(2) });
		expect(await followUp(late)).toMatchObject({ due: false, heldUntil: day(3), at: day(3) });
		await sendEscalationStepNow(targetId, `route:${host}:1`, late);
		// Its time had come: the hold is lifted, nothing is brought forward, and it is due as the operator now sees.
		expect(await followUp(late)).toMatchObject({ due: true, advanced: false, at: day(2) });
		expect(await queued(targetId)).toEqual([late]);
		await expect(sendEscalationStepNow(targetId, `route:${host}:1`, late)).rejects.toThrow("is due and goes out with the next run");
	});

	test("a hold that would end after the month is over plans nothing and leaves no job", async () => {
		const { reportId, targetId } = await onLadder();
		await AbuseRepository.appendEvent({ reportId, targetId, eventType: ESCALATION_HELD_EVENT, data: { at: day(25).toISOString(), verdict: "not_malicious" } });
		expect(pendingEscalationSteps((await escalationState(reportId, targetId)).ladder, day(25))).toEqual([]);
		await scheduleEscalation({ reportId, targetId }, day(25));
		expect(await queued(targetId)).toEqual([]);
		// Within the month the hold dates the steps due before it ends; a step due after it keeps its time.
		await AbuseRepository.appendEvent({ reportId, targetId, eventType: ESCALATION_HELD_EVENT, data: { at: day(10).toISOString(), verdict: "unverified" } });
		await scheduleEscalation({ reportId, targetId }, day(10));
		expect(await queued(targetId)).toEqual([day(11)]);
		expect(new Set(pendingEscalationSteps((await escalationState(reportId, targetId)).ladder, day(10)).map((step) => step.at.toISOString()))).toEqual(new Set([day(11).toISOString(), day(14).toISOString()]));
	});

	test("a canceled report, a target without a URL, or one whose job is not queued has no plan, and the operator cannot act on it", async () => {
		const db = await getDb();
		const canceled = await onLadder();
		db.update(abuseReports).set({ status: "canceled" }).where(eq(abuseReports.id, canceled.reportId)).run();
		expect((await view(canceled.reportId, day(1))).routes.flatMap((route) => route.escalation)).toEqual([]);
		await expect(skipEscalationStep(canceled.targetId, `route:${canceled.host}:1`, day(1))).rejects.toThrow("not on an escalation ladder");
		await scheduleEscalation(canceled, day(1));
		expect(await queued(canceled.targetId)).toEqual([]);

		const urlless = await onLadder();
		db.update(abuseTargets).set({ observedUrls: [] }).where(eq(abuseTargets.id, urlless.targetId)).run();
		await expect(sendEscalationStepNow(urlless.targetId, "site:4", day(1))).rejects.toThrow("not on an escalation ladder");
		await scheduleEscalation(urlless, day(1));
		expect(await queued(urlless.targetId)).toEqual([]);

		// Never put on the ladder (its site was down): no job is made for it by skipping.
		const down = await reported();
		await expect(skipEscalationStep(down.targetId, `route:${down.host}:1`, day(1))).rejects.toThrow("not on an escalation ladder");
		expect(await queued(down.targetId)).toEqual([]);
	});

	test("skipping the last step leaves no job waiting", async () => {
		const { reportId, targetId } = await onLadder();
		for (const step of pendingEscalationSteps((await escalationState(reportId, targetId)).ladder, day(1))) await skipEscalationStep(targetId, step.key, day(1));
		expect(await queued(targetId)).toEqual([]);
		expect((await upcomingEscalationSteps(day(1))).filter((step) => step.targetId === targetId.toString())).toEqual([]);
	});

	test("a report of two sites lists the next site step of each, under its own site", async () => {
		const { reportId, targetId } = await onLadder();
		const db = await getDb();
		const second = generateId();
		db.insert(abuseTargets).values({ id: second, reportId, ordinal: 1, originalInput: "paypal-login-check.com", originalInputs: ["paypal-login-check.com"], normalizedTarget: "paypal-login-check.com", targetType: "domain", observedUrls: ["https://paypal-login-check.com/"], resolutionStatus: "resolved" }).run();
		const route = generateId();
		const sentAt = day(1);
		db.insert(abuseProviderRoutes).values({ id: route, reportId, targetId: second, routeKey: `namesilo:${route}`, providerRegistryKey: "namesilo", providerDisplayName: "NameSilo Phishing Report", routeType: "provider_submission", verifiedEmail: null, resolverProvenance: { source: "registrar_rdap" }, resolutionSnapshot: {}, status: "submitted", createdAt: sentAt, updatedAt: sentAt }).run();
		db.insert(abuseProviderRuns).values({ id: generateId(), reportId, routeId: route, providerPayload: {}, payloadHash: String(route), correlationKey: `run:${route}`, attemptCount: 1, executionStatus: "completed", confirmationId: "NS-5000", createdAt: sentAt, updatedAt: sentAt }).run();
		db.insert(abuseEvents).values({ id: generateId(), reportId, routeId: route, eventType: "route.status_changed", data: { to: "submitted" }, createdAt: sentAt }).run();
		await scheduleEscalation({ reportId, targetId: second }, day(1));

		const sites = (await upcomingEscalationSteps(day(1))).filter((step) => !step.provider && [targetId.toString(), second.toString()].includes(step.targetId));
		expect(sites.map((step) => `${step.step} ${step.target} ${step.targetId} ${step.at}`)).toEqual([
			`oversight ${DOMAIN} ${targetId} ${day(7).toISOString()}`,
			`oversight paypal-login-check.com ${second} ${day(8).toISOString()}`,
		]);
		// The case view keeps them apart and in time order.
		expect((await view(reportId, day(1))).siteEscalation.map((step) => `${step.step} ${step.target}`)).toEqual([`oversight ${DOMAIN}`, "oversight paypal-login-check.com", `exhausted ${DOMAIN}`, "exhausted paypal-login-check.com"]);
	});
});

describe("POST /api/operator/escalation-plan/[targetId]", () => {
	const call = async (targetId: string, body: unknown, password = PASSWORD) => {
		const { POST } = await import("../../../app/api/operator/escalation-plan/[targetId]/route");
		const request = new Request(`http://localhost/api/operator/escalation-plan/${targetId}`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`operator:${password}`).toString("base64")}`, "content-type": "application/json" }, body: JSON.stringify(body) });
		return POST(request, { params: Promise.resolve({ targetId }) });
	};

	// The handler acts as of the clock: a day after the report.
	afterEach(() => { setSystemTime(); });

	test("skips or sends a step for the operator only, and says why it refuses", async () => {
		const { reportId, targetId, host } = await onLadder();
		setSystemTime(day(1));
		expect((await call(targetId.toString(), { step: `route:${host}:1`, action: "skip" }, "wrong-password-0123456789")).status).toBe(401);
		for (const body of [{ step: "route:1", action: "skip" }, { step: `route:${host}:1`, action: "delete" }, { step: "site:9", action: "skip" }]) {
			expect((await call(targetId.toString(), body)).status).toBe(400);
		}
		expect((await call("not-an-id", { step: "site:4", action: "skip" })).status).toBe(400);

		const skipped = await call(targetId.toString(), { step: `route:${host}:1`, action: "skip" });
		expect(skipped.status).toBe(200);
		expect(await taken(reportId)).toEqual([`follow_up@${host}:skipped`]);
		const again = await call(targetId.toString(), { step: `route:${host}:1`, action: "skip" });
		expect(again.status).toBe(409);
		expect(await again.json()).toEqual({ error: "This step was taken or skipped already, or is no longer planned; reload the page." });

		expect((await call(targetId.toString(), { step: "site:4", action: "send_now" })).status).toBe(200);
		expect((await view(reportId, day(1))).siteEscalation[0]).toMatchObject({ step: "oversight", at: day(1), advanced: true, due: true });
		expect(await queued(targetId)).toEqual([day(1)]);
	});
});

import { describe, expect, test } from "bun:test";

import { abuseEvents, abuseProviderRoutes } from "@/lib/abuse/schema";
import { AbuseRepository } from "@/lib/abuse/repository";
import { getDb } from "@/lib/db";
import { generateId } from "@/lib/db/ids";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import type { SubmissionReportMessage, SubmissionReportRoute } from "./abuse_details";
import { getReportsForSubmission } from "./abuse_details";
import { decisionOf, nextStep, plannedStepText, rankedRoutes, routeStanding, routeTimeline, shortUtc, subjectLabel, takedownSummary, untilText } from "./report_view";
import type { PlannedEscalationStep } from "./planned_escalation";
import { scheduleEscalation } from "@/lib/abuse/escalation/run";
import { seedTrylevoReports, trylevoAt } from "./trylevo_reports.fixtures";

useTemporaryDatabase();

const CASE = 384401854580134038n;

async function trylevo() {
	await SubmissionsEntity.create({ id: CASE, kind: "website", data: { kind: "website", website: { url: "https://trylevo.app/" } }, dedupeKey: "website-trylevo.app", status: "reported" });
	await seedTrylevoReports(CASE);
	return getReportsForSubmission(CASE);
}

const by = (routes: readonly SubmissionReportRoute[], organisation: string) => routes.find((route) => route.organisation === organisation)!;

describe("the reports of case 384401854580134038 as the case page reads them", () => {
	test("each provider row: who, its role and channel, where it stands in plain words, and the provider's own sentence", async () => {
		const [site, payloadHost] = await trylevo();
		expect(site!.subject).toBe("site");
		expect(subjectLabel(site!)).toBe("Malware site");
		expect(payloadHost!.subject).toBe("payload_host");
		expect(subjectLabel(payloadHost!)).toBe("Payload host");

		const rows = (routes: readonly SubmissionReportRoute[]) => routes.map((route) => {
			const standing = routeStanding(route);
			return { organisation: route.organisation, role: route.role, channel: route.channel, bucket: standing.bucket, label: standing.label, line: standing.line, quoted: standing.quoted, at: standing.at && shortUtc(standing.at, trylevoAt("00:00:00")), steps: Object.values(standing.steps).join(" ") };
		});
		expect(rows(site!.routes)).toEqual([
			{ organisation: "NameSilo", role: "registrar", channel: "web form", bucket: "received", label: "Received", line: "NameSilo accepted the phishing report.", quoted: false, at: "18:52", steps: "done done waiting" },
			{ organisation: "Netcraft", role: "blocklist", channel: "reporting API", bucket: "declined", label: "No threat found", line: "Automatically analysed, and no threats were found.", quoted: true, at: "19:00", steps: "done done negative" },
			// Its `accepted` after restricting access keeps the restriction and its sentence.
			{ organisation: "Cloudflare", role: "cdn", channel: "dashboard API", bucket: "action_taken", label: "Access restricted", line: "We have restricted access to the reported URL(s).", quoted: true, at: "19:00", steps: "done done done" },
			{ organisation: "Sollutium-NL", role: "host", channel: "email", bucket: "waiting", label: "Awaiting reply", line: "Emailed abuse-ams@v-sys.org", quoted: false, at: "19:05", steps: "done waiting todo" },
		]);
		expect(rows(payloadHost!.routes)).toEqual([
			{ organisation: "Eranet", role: "registrar", channel: "web form", bucket: "received", label: "Under review", line: undefined, quoted: false, at: "18:51", steps: "done done waiting" },
			{ organisation: "Netcraft", role: "blocklist", channel: "reporting API", bucket: "declined", label: "No threat found", line: "Automatically analysed, and no threats were found.", quoted: true, at: "18:59", steps: "done done negative" },
			{ organisation: "Cloudflare", role: "cdn", channel: "dashboard API", bucket: "unconfirmed", label: "Not confirmed yet", line: "Cloudflare's answer to our submission was lost", quoted: false, at: "18:50", steps: "unknown todo todo" },
		]);
	});

	test("the host Cloudflare named is that route's next hop, and the hop knows who named it", async () => {
		const [site] = await trylevo();
		const cloudflare = by(site!.routes, "Cloudflare");
		const host = by(site!.routes, "Sollutium-NL");
		expect(host.namedBy).toEqual({ routeId: cloudflare.id, organisation: "Cloudflare" });
		expect(routeTimeline(cloudflare, site!.routes).at(-1)).toEqual({ kind: "next_hop", at: trylevoAt("19:05:18"), routeId: host.id, organisation: "Sollutium-NL", role: "host" });
	});

	test("what happens next: the receipt lookup of a lost answer, the next status check, and a scan that found nothing", async () => {
		const [site, payloadHost] = await trylevo();
		const next = (route: SubmissionReportRoute) => nextStep(route, routeStanding(route), site!.createdAt);
		expect(next(by(payloadHost!.routes, "Cloudflare"))).toBe("Looking for the report in Cloudflare's list of received reports at 19:20 UTC.");
		expect(next(by(payloadHost!.routes, "Eranet"))).toBe("Next status check at 20:05 UTC.");
		expect(next(by(site!.routes, "Netcraft"))).toBe("Nothing more is planned: Netcraft's automatic scan found no threat.");
		expect(next(by(site!.routes, "Sollutium-NL"))).toBe("Nothing more is planned until Sollutium-NL replies; its reply is read automatically.");
		// A status check still to come is the next step; "nothing more is planned" would contradict it.
		const scanned = by(site!.routes, "Netcraft");
		expect(next({ ...scanned, nextWork: [{ kind: "status_check", at: new Date("2026-11-26T20:25:00Z") }] })).toBe("Netcraft's automatic scan found no threat. Next status check at 20:25 UTC.");
		// A settled route has nothing next.
		expect(next(by(site!.routes, "Cloudflare"))).toBeUndefined();
	});

	test("once liveness put the site on its escalation ladder, the host that has not answered is followed up two days after its report", async () => {
		const [site] = await trylevo();
		const target = (await AbuseRepository.listTargets(site!.id))[0]!;
		const now = trylevoAt("21:00:00");
		await scheduleEscalation({ reportId: site!.id, targetId: target.id }, now);
		const [later] = await getReportsForSubmission(CASE, now);
		const host = by(later!.routes, "Sollutium-NL");
		expect(nextStep(host, routeStanding(host), later!.createdAt)).toBe("Follow-up to Sollutium-NL at 28 Nov 19:05 UTC if it hasn't acted.");
		expect(host.escalation[0]).toMatchObject({ step: "follow_up", at: new Date(trylevoAt("19:05:18").getTime() + 2 * 86_400_000), to: { name: "Sollutium-NL", address: "abuse-ams@v-sys.org" } });
		expect(routeTimeline(host, later!.routes).at(-1)).toMatchObject({ kind: "planned", text: { heading: "Follow-up planned", condition: "if Sollutium-NL hasn't acted" } });
		// Cloudflare acted: no step of its own.
		expect(by(later!.routes, "Cloudflare").escalation).toEqual([]);
	});

	test("the takedown status: the strongest outcome first, counts by standing, targets and companies", async () => {
		const reports = await trylevo();
		const summary = takedownSummary(reports, String(CASE));
		expect(summary.counts).toEqual({ action_taken: 1, bypassed: 0, received: 2, declined: 2, unconfirmed: 1, waiting: 1, not_sent: 0 });
		// No check has seen the site move: Cloudflare's restriction stands.
		expect(summary.moved).toBeUndefined();
		expect({ total: summary.total, targets: summary.targets, providers: summary.providers, coveredBy: summary.coveredBy, alsoCovers: summary.alsoCovers }).toEqual({ total: 7, targets: 2, providers: 5, coveredBy: [], alsoCovers: [] });
		expect(summary.best?.route.organisation).toBe("Cloudflare");
		expect(summary.best?.report.target).toBe("trylevo.app");
		expect(rankedRoutes(reports).map(({ route, standing }) => `${route.organisation}:${standing.bucket}`)).toEqual([
			"Cloudflare:action_taken", "Eranet:received", "NameSilo:received", "Netcraft:declined", "Netcraft:declined", "Cloudflare:unconfirmed", "Sollutium-NL:waiting",
		]);
	});

	test("a timeline tells each message by its key sentence, with the full email clean and our quoted report folded", async () => {
		const [site] = await trylevo();
		const timeline = routeTimeline(by(site!.routes, "Cloudflare"), site!.routes);
		expect(timeline.map((entry) => entry.kind)).toEqual(["reported", "message", "states", "message", "states", "next_hop"]);
		expect(timeline[0]).toMatchObject({ title: "We reported through Cloudflare's dashboard API", receipt: "983629f3ca31bae5", confirmation: "Cloudflare accepted the phishing abuse report." });
		const response = timeline[3];
		if (response?.kind !== "message") throw new Error("not a message");
		expect(response).toMatchObject({ title: "Cloudflare replied", sentence: "We have restricted access to the reported URL(s).", highlight: true, decision: "action_taken" });
		expect(response.text?.main).toContain("Sollutium-NL - SOLLUTIUM EU Sp z.o.o., PL\nabuse-ams@v-sys.org");
		expect(response.text?.quoted).toStartWith("Below is the report we received:");
		const netcraft = routeTimeline(by(site!.routes, "Netcraft"), site!.routes).at(-1);
		if (netcraft?.kind !== "message") throw new Error("not a message");
		expect(netcraft.text?.main).not.toMatch(/@media|\{/);

		// The email route's report is the reported entry, with what we wrote.
		const host = routeTimeline(by(site!.routes, "Sollutium-NL"), site!.routes);
		expect(host).toHaveLength(1);
		expect(host[0]).toMatchObject({ kind: "reported", title: "We emailed abuse-ams@v-sys.org" });
		expect(host[0]?.kind === "reported" && host[0].sent).toStartWith("[Phishing Support] [PS-b7e34e00101c] Malware abuse");
	});

	test("a form that refused the report before sending says what it requires, and never that we reported", async () => {
		// Production case 383953602365887986, 12:16: Tucows' form refused the collector report, which named no brand.
		const [, payloadHost] = await trylevo();
		const db = await getDb();
		const [target] = await AbuseRepository.listTargets(payloadHost!.id);
		const id = generateId();
		db.insert(abuseProviderRoutes).values({
			id, reportId: payloadHost!.id, targetId: target!.id, routeKey: `tucows:${id}`, providerRegistryKey: "tucows", providerDisplayName: "Tucows Abuse Form",
			routeType: "provider_submission", resolverProvenance: { source: "domain_rdap" }, resolutionSnapshot: {}, status: "insufficient_evidence", createdAt: trylevoAt("18:50:09"), updatedAt: trylevoAt("18:50:11"),
		}).run();
		for (const [to, at, reason] of [["queued", "18:50:09", "route_resolved"], ["insufficient_evidence", "18:50:11", "tucows_requires_a_brand_domain"]] as const) {
			db.insert(abuseEvents).values({ id: generateId(), reportId: payloadHost!.id, routeId: id, eventType: "route.status_changed", data: { to, reason }, createdAt: trylevoAt(at) }).run();
		}
		const refused = (await getReportsForSubmission(CASE))[1]!.routes.find((item) => item.id === id)!;
		// The organisation's name leads: "Tucows" in production, its route's display name here without the site's record.
		const reason = `${refused.organisation} requires a brand domain.`;
		expect(refused.error).toBe(reason);
		expect(routeStanding(refused)).toMatchObject({ bucket: "not_sent", label: "Not enough evidence for this form", line: reason, steps: { sent: "negative" } });
		const timeline = routeTimeline(refused, [refused]);
		expect(timeline).toEqual([{ kind: "not_sent", at: trylevoAt("18:50:11"), title: `Not sent through ${refused.organisation}'s ${refused.channel}`, draft: refused.body }]);
		expect(refused.body).toBeTruthy();
	});
});

/** A route as the read model gives it, from the fields a test sets. */
function route(fields: Partial<SubmissionReportRoute> & { messages?: SubmissionReportMessage[] }): SubmissionReportRoute {
	return {
		id: 1n, provider: "Cloudflare Abuse", organisation: "Cloudflare", icon: null, role: "cdn", channel: "dashboard API", namedBy: null, nextWork: [],
		outcome: { verdict: "acknowledged", sentAt: trylevoAt("18:51:08"), followUps: 0, unansweredDecisions: 0, overturnedByFollowUp: false, inbound: 0, outbound: 0 },
		routeType: "provider_submission", target: "hostsync.pro", recipient: null, status: "submitted", executionStatus: "completed", body: null, bodySource: null,
		observedUrls: [], submittedTargets: [], confirmationId: "8bb11a971b4aee08", confirmationText: null, finalUrl: null, error: null, messages: [], decisionFollowUps: [], escalation: [],
		createdAt: trylevoAt("18:50:53"), updatedAt: trylevoAt("19:20:56"),
		...fields,
	};
}

function message(fields: Partial<SubmissionReportMessage> & { at: string }): SubmissionReportMessage {
	const { at, ...rest } = fields;
	return {
		id: BigInt(trylevoAt(at).getTime()), direction: "inbound", kind: "provider_api", status: "received", classification: null, fromAddress: null, toAddresses: [], subject: null,
		text: null, providerState: null, decision: null, messageId: null, replyAddress: null, rawArtifactId: null, attachmentArtifactIds: [], decisionReply: false, moveNotice: false, occurredAt: trylevoAt(at),
		...rest,
	};
}

const state = (at: string, value: string, extra: Partial<SubmissionReportMessage> = {}) => message({ at, subject: `Report status: ${value}`, providerState: { state: value, detail: null }, ...extra });

describe("routeStanding and the timeline from a route's own record", () => {
	test("Cloudflare's denial we answered with evidence: declined in plain words, our answer and the next check as what happens next", () => {
		// Production, 19:20-19:22: hostsync.pro's report was denied as content_removed and answered with the payload evidence.
		const denied = route({
			messages: [
				state("19:20:57", "denied", { providerState: { state: "denied", detail: "content_removed" }, classification: "rejected", decision: { outcome: "declined", label: "Declined: content not visible" } }),
				message({ at: "19:22:47", direction: "outbound", kind: "report", status: "sent", decisionReply: true, subject: "[8bb11a971b4aee08] Additional evidence for abuse report 8bb11a971b4aee08" }),
			],
			decisionFollowUps: [{ outcome: "replied", decision: "content_removed", explanation: "The reported path still returns the identical payload with curl/8.7.1.", occurredAt: trylevoAt("19:22:47") }],
			nextWork: [{ kind: "status_check", at: trylevoAt("20:20:57") }],
		});
		const standing = routeStanding(denied);
		expect(standing).toMatchObject({ bucket: "declined", label: "Declined: content not visible", quoted: false, steps: { sent: "done", received: "done", decision: "negative" } });
		expect(nextStep(denied, standing, trylevoAt("18:50:04"))).toBe("We answered with evidence at 19:22 UTC; awaiting Cloudflare's review. Next status check at 20:20 UTC.");
		const answer = routeTimeline(denied, [denied]).at(-1);
		expect(answer).toMatchObject({ kind: "message", inbound: false, title: "We answered the decision", sentence: "The reported path still returns the identical payload with curl/8.7.1." });
	});

	test("a route that never left shows its draft as not sent; a bounced email still shows what we sent", () => {
		const notSent = { verdict: "not_delivered", followUps: 0, unansweredDecisions: 0, overturnedByFollowUp: false, inbound: 0, outbound: 0 } as const;
		const parked = route({ status: "needs_human", outcome: notSent, confirmationId: null, body: "Draft text" });
		expect(routeTimeline(parked, [parked])).toEqual([{ kind: "not_sent", at: trylevoAt("19:20:56"), title: "Not sent through Cloudflare's dashboard API", draft: "Draft text" }]);
		const unrouted = route({ routeType: "email", status: "delivery_failed", outcome: notSent, recipient: "abuse@host.example", confirmationId: null, body: null });
		expect(routeTimeline(unrouted, [unrouted])[0]).toMatchObject({ kind: "not_sent", title: "Not emailed to abuse@host.example", draft: null });

		const bounced = route({
			routeType: "email", status: "delivery_failed", recipient: "abuse@host.example", confirmationId: null,
			outcome: { ...notSent, verdict: "bounced", sentAt: trylevoAt("19:00:00") },
			messages: [
				message({ at: "19:00:00", direction: "outbound", kind: "report", status: "sent", subject: "Abuse report", text: { main: "Body", quoted: null } as never }),
				message({ at: "19:01:00", kind: "bounce", classification: "bounce", subject: "Undeliverable" }),
			],
		});
		const timeline = routeTimeline(bounced, [bounced]);
		expect(timeline[0]).toMatchObject({ kind: "reported", title: "We emailed abuse@host.example", sent: "Abuse report\n\nBody" });
		expect(timeline[1]).toMatchObject({ kind: "message", title: "Delivery failed", failed: true });
	});

	test("consecutive review states are one line; a state between messages starts a new one", () => {
		const record = route({ messages: [state("18:51:13", "submitted"), state("19:05:12", "accepted", { classification: "acknowledged" }), message({ at: "19:10:00", subject: "Hi" }), state("19:20:00", "denied")] });
		const states = routeTimeline(record, [record]).filter((entry) => entry.kind === "states");
		expect(states.map((entry) => entry.kind === "states" && entry.states.map((item) => `${item.state} ${shortUtc(item.at, trylevoAt("00:00:00"))}`))).toEqual([["submitted 18:51", "accepted 19:05"], ["denied 19:20"]]);
	});

	test("a later answer that agrees keeps the decision and its sentence; one that disagrees replaces it", () => {
		const restricted = message({ at: "19:00:46", decision: { outcome: "action_taken", label: "Access restricted", sentence: "We have restricted access to the reported URL(s)." } });
		expect(decisionOf([restricted, state("19:05:12", "accepted", { classification: "acknowledged" })])?.decision.label).toBe("Access restricted");
		expect(decisionOf([restricted, state("19:30:00", "denied", { classification: "rejected" })])?.decision).toEqual({ outcome: "declined", label: "Declined" });
		// A review state that decides nothing is a report under review, quoted as its state.
		expect(decisionOf([state("18:51:54", "material auditing")])?.decision).toEqual({ outcome: "received", label: "Under review", sentence: "Status “material auditing”" });
		// A bounce or our own relay's refusal is not the provider's answer.
		expect(decisionOf([message({ at: "19:00:00", kind: "bounce", classification: "bounce" }), message({ at: "19:01:00", classification: "relay_refused" })])).toBeUndefined();
	});

	test("reports that never reached the provider, and one still being sent", () => {
		expect(routeStanding(route({ status: "provider_rejected", error: "Duplicate report.", outcome: { verdict: "not_delivered", followUps: 0, unansweredDecisions: 0, overturnedByFollowUp: false, inbound: 0, outbound: 0 } })))
			.toMatchObject({ bucket: "not_sent", label: "Refused by the provider's form", line: "Duplicate report.", steps: { sent: "negative" } });
		expect(routeStanding(route({ routeType: "email", status: "awaiting_provider_reply", outcome: { verdict: "bounced", sentAt: trylevoAt("19:00:00"), followUps: 0, unansweredDecisions: 0, overturnedByFollowUp: false, inbound: 1, outbound: 1 } })))
			.toMatchObject({ bucket: "not_sent", label: "Bounced" });
		const sending = route({ status: "queued", outcome: { verdict: "pending", followUps: 0, unansweredDecisions: 0, overturnedByFollowUp: false, inbound: 0, outbound: 0 }, nextWork: [{ kind: "submission", at: trylevoAt("18:55:00") }] });
		expect(routeStanding(sending)).toMatchObject({ bucket: "waiting", label: "Being sent" });
		expect(nextStep(sending, routeStanding(sending), trylevoAt("18:50:00"))).toBe("Sending at 18:55 UTC.");
	});

	test("how far a planned step is: minutes, hours, days ahead; overdue once past", () => {
		const now = trylevoAt("12:00:00");
		const after = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
		expect([0.2, 40, 59, 60, 90, 47 * 60, 48 * 60, 2.4 * 1440].map((minutes) => untilText(after(minutes), now))).toEqual(["in 1m", "in 40m", "in 59m", "in 1h", "in 2h", "in 47h", "in 2d", "in 2d"]);
		// Due within the last minute is due now, never "in 1m" while the chip says due; past that it is overdue.
		expect([0, -0.1, -0.49, -0.99, -1, -1.6, -30, -3 * 60, -3 * 1440].map((minutes) => untilText(after(minutes), now))).toEqual([
			"due now", "due now", "due now", "due now", "1m overdue", "2m overdue", "30m overdue", "3h overdue", "3d overdue",
		]);
		expect(untilText(after(90).toISOString(), now.toISOString())).toBe("in 2h");
	});

	test("a lost answer with its lookups over is left for a person, and dates of another day name the day", () => {
		const lost = route({ status: "unknown_external_state" });
		expect(nextStep(lost, routeStanding(lost))).toBe("No further automatic check; the report is looked into by hand.");
		expect(shortUtc(new Date("2026-11-27T19:21:00Z"), trylevoAt("18:50:00"))).toBe("27 Nov 19:21");
	});
});

describe("a planned step in words", () => {
	const step = (fields: Partial<PlannedEscalationStep>): PlannedEscalationStep => ({ key: "route:1:1", targetId: 1n, step: "follow_up", routeId: 1n, at: trylevoAt("19:00:00"), advanced: false, due: false, ...fields });

	test("each step says whom it reaches and on what condition; a provider's form is written through, a mailbox at", () => {
		expect(plannedStepText(step({ to: { name: "Eranet", address: "Eranet's supplement form" } }), "Eranet").sentence).toBe("We'll write to Eranet again through Eranet's supplement form, on its own report, with proof that the site still serves the reported content.");
		expect(plannedStepText(step({ to: { name: "Cloudflare", address: "abusereply@cloudflare.com" } }), "Cloudflare").sentence).toBe("We'll write to Cloudflare again at abusereply@cloudflare.com, on its own report, with proof that the site still serves the reported content.");
		expect(plannedStepText(step({ step: "next_contact", key: "route:1:2", to: { name: "Parent Net", address: "abuse@parent.example" } }), "Host")).toMatchObject({ label: "Escalate", heading: "Escalation planned", condition: "if Host hasn't acted", sentence: "We'll report the site to Parent Net (abuse@parent.example), the next abuse contact Host publishes for its network." });
		expect(plannedStepText(step({ step: "upstream", key: "route:1:3", to: { name: "Transit", address: "noc@transit.example" } }), "Host").sentence).toBe("We'll report the site to Transit (noc@transit.example), the upstream transit provider of Host's network, naming Host as its customer.");
		expect(plannedStepText(step({ step: "exhausted", key: "site:5", routeId: undefined }))).toMatchObject({ label: "Review", condition: "if the site is still up" });
	});

	test("a hold and the operator bringing it forward are noted before the condition every step has", () => {
		expect(plannedStepText(step({ heldUntil: trylevoAt("20:00:00"), advanced: true }), "Host", trylevoAt("18:00:00")).notes).toEqual([
			"On hold until 20:00 UTC: our last check did not find the reported content.",
			"Brought forward by our team.",
			"It happens only if a check right before then finds the site still serving the reported content.",
		]);
	});
});

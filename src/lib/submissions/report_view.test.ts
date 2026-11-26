import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import type { SubmissionReportMessage, SubmissionReportRoute } from "./abuse_details";
import { getReportsForSubmission } from "./abuse_details";
import { decisionOf, nextStep, rankedRoutes, routeStanding, routeTimeline, shortUtc, subjectLabel, takedownSummary } from "./report_view";
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
		expect(next(by(site!.routes, "Netcraft"))).toBe("Netcraft's automatic scan found no threat.");
		expect(next(by(site!.routes, "Sollutium-NL"))).toBe("No reply from Sollutium-NL yet.");
		// A settled route has nothing next.
		expect(next(by(site!.routes, "Cloudflare"))).toBeUndefined();
	});

	test("the takedown status: the strongest outcome first, counts by standing, targets and companies", async () => {
		const reports = await trylevo();
		const summary = takedownSummary(reports, String(CASE));
		expect(summary.counts).toEqual({ action_taken: 1, received: 2, declined: 2, unconfirmed: 1, waiting: 1, not_sent: 0 });
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
});

/** A route as the read model gives it, from the fields a test sets. */
function route(fields: Partial<SubmissionReportRoute> & { messages?: SubmissionReportMessage[] }): SubmissionReportRoute {
	return {
		id: 1n, provider: "Cloudflare Abuse", organisation: "Cloudflare", role: "cdn", channel: "dashboard API", namedBy: null, nextWork: [],
		outcome: { verdict: "acknowledged", sentAt: trylevoAt("18:51:08"), followUps: 0, unansweredDecisions: 0, overturnedByFollowUp: false, inbound: 0, outbound: 0 },
		routeType: "provider_submission", target: "hostsync.pro", recipient: null, status: "submitted", executionStatus: "completed", body: null, bodySource: null,
		observedUrls: [], submittedTargets: [], confirmationId: "8bb11a971b4aee08", confirmationText: null, finalUrl: null, error: null, messages: [], decisionFollowUps: [],
		createdAt: trylevoAt("18:50:53"), updatedAt: trylevoAt("19:20:56"),
		...fields,
	};
}

function message(fields: Partial<SubmissionReportMessage> & { at: string }): SubmissionReportMessage {
	const { at, ...rest } = fields;
	return {
		id: BigInt(trylevoAt(at).getTime()), direction: "inbound", kind: "provider_api", status: "received", classification: null, fromAddress: null, toAddresses: [], subject: null,
		text: null, providerState: null, decision: null, messageId: null, replyAddress: null, rawArtifactId: null, attachmentArtifactIds: [], decisionReply: false, occurredAt: trylevoAt(at),
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

	test("a lost answer with its lookups over is left for a person, and dates of another day name the day", () => {
		const lost = route({ status: "unknown_external_state" });
		expect(nextStep(lost, routeStanding(lost))).toBe("No further automatic check; the report is looked into by hand.");
		expect(shortUtc(new Date("2026-11-27T19:21:00Z"), trylevoAt("18:50:00"))).toBe("27 Nov 19:21");
	});
});

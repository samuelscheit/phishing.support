import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { approveDraftedMail } from "../approval/drafted_mail";
import { approvalDraftOf } from "../persistence/approvals";
import { AbuseRepository } from "../repository";
import { routeContact } from "../resolver/contact_chain";
import { abuseEvents, abuseJobs, abuseMailMessages, type AbuseProviderRoute } from "../schema";
import type { sendAbuseEmailRoute } from "../mail/send";
import { ESCALATION_EVENT, ESCALATION_HELD_EVENT, escalationJobKey, type EscalationDependencies } from "./run";
import { day, DOMAIN, relay, reported, SENT, site, URL_, work } from "./run.fixtures";

useTemporaryDatabase();

const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "escalation-test-secret-32-bytes-long!!"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

const steps = async (reportId: bigint) => (await AbuseRepository.listEvents(reportId)).filter((event) => event.eventType === ESCALATION_EVENT).map((event) => `${(event.data as { step: string }).step}${event.routeId ? `@${event.routeId}` : ""}:${(event.data as { action: string }).action}`);
const queued = async (targetId: bigint) => (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.dedupeKey, escalationJobKey(targetId))).all().filter((job) => job.status === "queued").map((job) => job.nextAttemptAt);
const routes = async (reportId: bigint): Promise<AbuseProviderRoute[]> => AbuseRepository.listRoutes(reportId);

describe("escalating a report nobody acts on", () => {
	test("climbs the whole ladder while the site serves the reported page, each step once", async () => {
		const { reportId, targetId, host, registrar } = await reported();
		const { sent, send } = relay();
		const countries: number[] = [];
		const dependencies = (at: Date): EscalationDependencies => ({
			verify: { site: { ...site("kit"), now: () => at }, isShared: async () => false },
			send,
			providerFor: () => undefined,
			countryOf: async (asn) => { countries.push(asn); return "NL"; },
			now: () => at,
		});

		// Nothing is due a day after the report: the job is queued for the follow-up.
		await work(targetId, dependencies(day(1)));
		expect(await steps(reportId)).toEqual([]);
		expect(await queued(targetId)).toEqual([day(2)]);

		// Day 2: the host is followed up on its own thread with the proof; the registrar's form has no follow-up channel.
		await work(targetId, dependencies(day(2)));
		expect(await steps(reportId)).toEqual([`follow_up@${host}:followed_up`, `follow_up@${registrar}:no_channel`]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ recipient: "abuse@hosting.example", subject: `Re: [Phishing Support] Abuse report for ${DOMAIN}`, replyAddress: "abuse-r1@reply.phishing.support", correlationKey: `escalation:${host}:1` });
		expect(sent[0]!.body).toContain(`On 20 Nov 2026 10:00 UTC we reported the phishing page at ${URL_}`);
		expect(sent[0]!.body).toMatch(/Checked 22 Nov 2026 10:00 UTC with a plain request:\n- https:\/\/paypal-verify-account\.com\/signin serves a page built from the same template as the one we captured when we reported it \(structure SHA-256 [a-f0-9]{64}\)\./);
		expect(sent[0]!.body).toContain("Impersonated brand: PayPal");
		const verified = (await AbuseRepository.listEvents(reportId)).filter((event) => event.eventType === "site.content_verified");
		expect(verified.map((event) => (event.data as { verdict: string; tier: string })).map(({ verdict, tier }) => `${verdict}/${tier}`)).toEqual(["served/fetch"]);
		expect(await queued(targetId)).toEqual([day(4)]);

		// Day 4: the host's next published contact, never the transit provider; the registrar's form route has none.
		await work(targetId, dependencies(day(4)));
		expect((await steps(reportId)).slice(2)).toEqual([`next_contact@${host}:reported`, `next_contact@${registrar}:no_contact`]);
		const parent = (await routes(reportId)).find((route) => route.verifiedEmail === "abuse@parent-net.example")!;
		expect(parent.status).toBe("verified");
		expect(routeContact(parent.resolverProvenance)).toMatchObject({ reason: "escalation_no_action", escalation: { level: 2, fromRouteId: host.toString(), fromProvider: "Example Hosting B.V.", fromEmail: "abuse@hosting.example", reportedAt: SENT.toISOString() } });
		// The new report keeps the transit provider as its fallback.
		expect((parent.resolverProvenance.fallbackContacts as Array<{ email: string }>).map((contact) => contact.email)).toEqual(["noc@transit.example"]);
		expect((await getDb()).select().from(abuseJobs).where(eq(abuseJobs.routeId, parent.id)).all().map((job) => job.jobType)).toContain("send_email");

		// Day 5: the upstream transit provider, as a report that names its customer.
		await work(targetId, dependencies(day(5)));
		expect((await steps(reportId)).slice(4)).toEqual([`upstream@${host}:reported`]);
		const transit = (await routes(reportId)).find((route) => route.verifiedEmail === "noc@transit.example")!;
		expect(routeContact(transit.resolverProvenance)).toMatchObject({ transit: { upstreamAsn: 174, customerAsn: 64500 }, escalation: { level: 3 } });

		// Day 7: drafts to the Dutch CERT, a DSA notice to the EU host and PayPal, none sent; the ICANN complaint is prepared for the operator.
		await work(targetId, dependencies(day(7)));
		const oversight = (await AbuseRepository.listEvents(reportId)).find((event) => event.eventType === ESCALATION_EVENT && (event.data as { step: string }).step === "oversight")!;
		expect(oversight.data).toMatchObject({ level: 4, action: "drafted", country: "NL", manual: [{ kind: "icann_complaint", formUrl: "https://www.icann.org/compliance/complaint", registrar: "NameSilo" }] });
		expect(countries).toEqual([64500]);
		const drafts = (await routes(reportId)).filter((route) => route.status === "awaiting_approval");
		expect(drafts.map((route) => `${route.providerRegistryKey} ${route.verifiedEmail}`).sort()).toEqual(["escalation:brand phishing@paypal.com", "escalation:cert cert@ncsc.nl", "escalation:dsa_notice abuse@hosting.example"]);
		const dsa = approvalDraftOf(drafts.find((route) => route.providerRegistryKey === "escalation:dsa_notice")!)!;
		expect(dsa.subject).toContain("Article 16 Regulation (EU) 2022/2065");
		expect(dsa.body).toContain("2. Exact location (Art. 16(2)(b)): https://paypal-verify-account.com/signin, served from 203.0.113.10 (AS64500 EXAMPLE-HOSTING)");
		const cert = approvalDraftOf(drafts.find((route) => route.providerRegistryKey === "escalation:cert")!)!;
		expect(cert.body).toContain("served from a network registered in NL");
		expect(cert.body).toContain("- Example Hosting B.V. (host, abuse@hosting.example): reported 20 Nov 2026 10:00 UTC; we have received no confirmation of action.");
		expect(cert.body).toContain("- NameSilo (registrar): reported 20 Nov 2026 10:00 UTC, reference NS-4471; we have received no confirmation of action.");
		expect((oversight.data as { manual: Array<{ text: string }> }).manual[0]!.text).toContain("RAA §3.18.1");
		// Nothing goes out before the operator approves it.
		expect(sent).toHaveLength(1);
		await approveDraftedMail(drafts.find((route) => route.providerRegistryKey === "escalation:cert")!.id);
		expect((await AbuseRepository.getRoute(drafts.find((route) => route.providerRegistryKey === "escalation:cert")!.id))!.status).toBe("verified");

		// Day 14: nothing automatic is left; the operator decides. The ladder is done.
		await work(targetId, dependencies(day(14)));
		expect((await steps(reportId)).at(-1)).toBe("exhausted:needs_human");
		await work(targetId, dependencies(day(20)));
		expect((await steps(reportId)).filter((step) => step.startsWith("follow_up@") || step.startsWith("oversight"))).toHaveLength(3);
		// A retried job takes no step twice and sends nothing again.
		await work(targetId, dependencies(day(7)));
		expect(sent).toHaveLength(1);

		// The operator sees the drafts still waiting and the steps only a person can take, and settles each once.
		const { listDraftedMails } = await import("../approval/drafted_mail");
		expect((await listDraftedMails()).filter((mail) => mail.target === DOMAIN).map((mail) => `${mail.kind} ${mail.recipient}`).sort()).toEqual(["brand phishing@paypal.com", "dsa_notice abuse@hosting.example"]);
		const { openEscalationSteps, resolveEscalationStep } = await import("./manual");
		const open = (await openEscalationSteps()).filter((step) => step.reportId === reportId.toString());
		expect(open.map((step) => step.kind)).toEqual(["icann_complaint", "decision"]);
		expect(open[0]).toMatchObject({ registrar: "NameSilo", target: DOMAIN, formUrl: "https://www.icann.org/compliance/complaint", caseHref: expect.stringMatching(/^\/submissions\/\d+$/) });
		await resolveEscalationStep(BigInt(open[0]!.eventId), "filed");
		await expect(resolveEscalationStep(BigInt(open[0]!.eventId), "dismissed")).rejects.toThrow("settled already");
		expect((await openEscalationSteps()).filter((step) => step.reportId === reportId.toString()).map((step) => step.kind)).toEqual(["decision"]);
		// Only an escalation step can be settled this way.
		const followUp = (await AbuseRepository.listEvents(reportId)).find((event) => event.eventType === ESCALATION_EVENT && (event.data as { step: string }).step === "follow_up")!;
		await expect(resolveEscalationStep(followUp.id, "filed")).rejects.toThrow("not an escalation step waiting for you");
	});

	test("a site taken down holds the ladder; a page that cannot be confirmed is looked at again a day later", async () => {
		const { reportId, targetId } = await reported();
		const { sent, send } = relay();
		await work(targetId, { verify: { site: site("gone"), isShared: async () => false }, send, now: () => day(2) });
		expect(await steps(reportId)).toEqual([]);
		expect(sent).toEqual([]);
		const held = (await AbuseRepository.listEvents(reportId)).filter((event) => event.eventType === ESCALATION_HELD_EVENT);
		expect(held.map((event) => event.data)).toEqual([{ at: day(2).toISOString(), verdict: "gone", tier: "check", checkedAt: expect.any(String), due: ["follow_up", "follow_up"] }]);
		// Looked at again a day later, while the month lasts.
		expect(await queued(targetId)).toEqual([day(3)]);

		// A browser service failure is not the site's: the job fails and the worker retries it.
		await expect(work(targetId, { verify: { site: site("decoy"), isShared: async () => false, capture: async () => { throw new Error("Browser Fabric session ended"); } }, send, now: () => day(2) })).rejects.toThrow("Browser Fabric session ended");
		// A decoy for every request and every network failing in the browser: unverified, tried again tomorrow.
		const { WebsiteCaptureFailedError, WebsiteUnreachableError } = await import("../../website/archive/errors");
		const failing = async () => { throw new WebsiteCaptureFailedError([new WebsiteUnreachableError("residential", "net::ERR_TIMED_OUT")]); };
		await work(targetId, { verify: { site: site("decoy"), isShared: async () => false, capture: failing }, send, now: () => day(2) });
		expect(await queued(targetId)).toEqual([day(3)]);
		expect(sent).toEqual([]);
	});

	test("liveness checks do not pull a held ladder forward: a week after a harmless page, a day after an unconfirmed one", async () => {
		const { reportId, targetId } = await reported();
		const { scheduleEscalation } = await import("./run");
		await work(targetId, { verify: { site: site("decoy"), isShared: async () => false, capture: async ({ url }) => ({ requestedUrl: url, url, hostname: DOMAIN, navigationHops: [{ index: 0, url, hostname: DOMAIN, status: 200, contentCaptured: true }], archivedAt: day(2), mhtml: Buffer.from(""), html: Buffer.from("<p>bakery</p>"), text: Buffer.from("bakery") }), classify: async () => ({ finding: "insufficient_evidence", reason: "a bakery" }) }, now: () => day(2) });
		expect((await AbuseRepository.listEvents(reportId)).filter((event) => event.eventType === ESCALATION_HELD_EVENT).map((event) => (event.data as { verdict: string }).verdict)).toEqual(["not_malicious"]);
		// Every later liveness check asks again: the ladder stays held for the week.
		for (const at of [day(2.5), day(3), day(6)]) await scheduleEscalation({ reportId, targetId }, at);
		expect(await queued(targetId)).toEqual([day(9)]);
	});

	test("a site that moved is not escalated to the hosting it left; the registrar still is", async () => {
		const { reportId, targetId, host, registrar } = await reported();
		await AbuseRepository.appendEvent({ reportId, targetId, eventType: "site.host_moved", data: {
			key: `${targetId}->AS64999`, targetId: targetId.toString(), at: day(1).toISOString(), since: SENT.toISOString(), kind: "new_network",
			from: { name: "EXAMPLE-HOSTING", asn: 64500, addresses: ["203.0.113.10"] }, to: { name: "OTHER-NET", asn: 64999, addresses: ["198.51.100.7"] },
			content: "served", evidence: { url: URL_, state: "online", httpStatus: 200, kitFiles: [] },
		} });
		const { sent, send } = relay();
		const dependencies = (at: Date): EscalationDependencies => ({ verify: { site: site("kit"), isShared: async () => false }, send, providerFor: () => undefined, countryOf: async () => "NL", now: () => at });
		await work(targetId, dependencies(day(2)));
		expect(await steps(reportId)).toEqual([`follow_up@${host}:site_moved`, `follow_up@${registrar}:no_channel`]);
		expect(sent).toEqual([]);
		for (const at of [day(4), day(5), day(7)]) await work(targetId, dependencies(at));
		// No DSA notice to the old host, and it is not named as the host that failed to act.
		const drafts = (await routes(reportId)).filter((route) => route.status === "awaiting_approval");
		expect(drafts.map((route) => route.providerRegistryKey).sort()).toEqual(["escalation:brand", "escalation:cert"]);
		expect(approvalDraftOf(drafts[0]!)!.body).not.toContain("Example Hosting");
		expect((await routes(reportId)).some((route) => route.verifiedEmail === "abuse@parent-net.example")).toBe(false);
	});

	test("a report that bounced was never received: that route does not climb", async () => {
		const { reportId, targetId, host, registrar } = await reported();
		(await getDb()).insert(abuseMailMessages).values({ id: generateId(), reportId, routeId: host, direction: "inbound", kind: "bounce", status: "received", fromAddress: "MAILER-DAEMON@hosting.example", toAddresses: [], subject: "Undeliverable", textBody: "550 5.1.1 mailbox unavailable", occurredAt: day(0.1) }).run();
		const { sent, send } = relay();
		await work(targetId, { verify: { site: site("kit"), isShared: async () => false }, send, providerFor: () => undefined, now: () => day(2) });
		expect(await steps(reportId)).toEqual([`follow_up@${registrar}:no_channel`]);
		expect(sent).toEqual([]);
	});

	test("a follow-up that may have gone out is taken, never sent again", async () => {
		const { reportId, targetId, host, registrar } = await reported();
		const unknown = (async () => ({ messageId: 0n, status: "unknown_external_state", error: "SMTP connection dropped after DATA" })) as unknown as typeof sendAbuseEmailRoute;
		await work(targetId, { verify: { site: site("kit"), isShared: async () => false }, send: unknown, providerFor: () => undefined, now: () => day(2) });
		expect(await steps(reportId)).toEqual([`follow_up@${host}:unknown`, `follow_up@${registrar}:no_channel`]);
		const { sent, send } = relay();
		await work(targetId, { verify: { site: site("kit"), isShared: async () => false }, send, providerFor: () => undefined, now: () => day(2) });
		expect(sent).toEqual([]);
	});

	test("a step that fails leaves the other providers' steps taken, and only it is retried", async () => {
		const { reportId, targetId, host, registrar } = await reported();
		const refusing = (async () => { throw new Error("SMTP relay unreachable"); }) as unknown as typeof sendAbuseEmailRoute;
		await expect(work(targetId, { verify: { site: site("kit"), isShared: async () => false }, send: refusing, providerFor: () => undefined, now: () => day(2) })).rejects.toThrow("SMTP relay unreachable");
		expect(await steps(reportId)).toEqual([`follow_up@${registrar}:no_channel`]);
		const { sent, send } = relay();
		await work(targetId, { verify: { site: site("kit"), isShared: async () => false }, send, providerFor: () => undefined, now: () => day(2) });
		expect(await steps(reportId)).toEqual([`follow_up@${registrar}:no_channel`, `follow_up@${host}:followed_up`]);
		expect(sent).toHaveLength(1);
	});

	test("a step that created its contact but was not recorded does not report a further contact when it runs again", async () => {
		const { reportId, targetId, host } = await reported();
		const { send } = relay();
		const dependencies = (at: Date): EscalationDependencies => ({ verify: { site: site("kit"), isShared: async () => false }, send, providerFor: () => undefined, now: () => at });
		await work(targetId, dependencies(day(2)));
		await work(targetId, dependencies(day(4)));
		const recorded = (await AbuseRepository.listEvents(reportId)).find((event) => event.routeId === host && (event.data as { step: string }).step === "next_contact")!;
		// As if the worker died right after creating the route.
		(await getDb()).delete(abuseEvents).where(eq(abuseEvents.id, recorded.id)).run();
		await work(targetId, dependencies(day(4)));
		const created = (await routes(reportId)).filter((route) => routeContact(route.resolverProvenance).escalation);
		expect(created.map((route) => route.verifiedEmail)).toEqual(["abuse@parent-net.example"]);
		expect((await steps(reportId)).filter((step) => step.startsWith(`next_contact@${host}`))).toEqual([`next_contact@${host}:reported`]);
	});

	test("a provider that acted leaves the ladder: only the others climb", async () => {
		const { reportId, targetId, host, registrar } = await reported();
		// Cloudflare restricted access: it did what it can; the host and the registrar did not.
		const cloudflare = await AbuseRepository.upsertResolvedRoute(targetId, { routeKey: "provider_submission:cloudflare:contact", providerRegistryKey: "cloudflare", providerDisplayName: "Cloudflare Abuse", routeType: "provider_submission", resolverProvenance: { source: "domain_infrastructure_ip" }, resolutionSnapshot: {}, status: "verified" });
		const run = await AbuseRepository.createProviderRun({ routeId: cloudflare.id, providerPayload: {}, correlationKey: `cf:${cloudflare.id}` });
		await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId: "983629f3ca31bae5", submittedTargets: [DOMAIN] });
		await AbuseRepository.recordProviderCorrespondence({ route: cloudflare, messages: [{ id: "response-1", subject: "[983629f3ca31bae5]: Response to your Phishing report", body: "We have restricted access to the reported URL(s).", sentAt: day(0.5), from: "Cloudflare Abuse" }] });
		const { send } = relay();
		await work(targetId, { verify: { site: site("kit"), isShared: async () => false }, send, providerFor: () => undefined, now: () => day(2) });
		expect((await steps(reportId)).sort()).toEqual([`follow_up@${host}:followed_up`, `follow_up@${registrar}:no_channel`].sort());
	});
});

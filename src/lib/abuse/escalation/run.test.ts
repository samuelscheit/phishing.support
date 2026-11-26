import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { generateId } from "../../db/ids";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { recordSiteCheck } from "../../liveness/repository";
import { DAY_MS } from "../../util/date_time";
import { templatePage } from "../../website/test_mhtml";
import { approveDraftedMail } from "../approval/drafted_mail";
import { validateAbuseReportRequest } from "../contracts";
import { approvalDraftOf } from "../persistence/approvals";
import { AbuseRepository } from "../repository";
import { routeContact } from "../resolver/contact_chain";
import { abuseEvents, abuseJobs, abuseMailMessages, abuseProviderRoutes, abuseProviderRuns, type AbuseProviderRoute } from "../schema";
import type { sendAbuseEmailRoute } from "../mail/send";
import { ESCALATION_EVENT, ESCALATION_HELD_EVENT, escalationJobKey, runEscalation, type EscalationDependencies } from "./run";

useTemporaryDatabase();

const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "escalation-test-secret-32-bytes-long!!"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

const DOMAIN = "paypal-verify-account.com";
const URL_ = `https://${DOMAIN}/signin`;
const SENT = new Date("2026-11-20T10:00:00Z");
const day = (days: number) => new Date(SENT.getTime() + days * DAY_MS);
const KIT = (token: string) => `<html><body><input type="hidden" name="t" value="${token}">${templatePage(10, (card) => `Confirm your PayPal account ${card} `.repeat(4))}</body></html>`;

/** The site as checks see it: up and serving the kit, or gone. */
function site(state: "kit" | "gone" | "decoy"): NonNullable<EscalationDependencies["verify"]>["site"] {
	return {
		dns: {
			resolve4: async () => {
				if (state === "gone") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
				return ["203.0.113.10"];
			},
			resolve6: async () => { throw Object.assign(new Error("ENODATA"), { code: state === "gone" ? "ENOTFOUND" : "ENODATA" }); },
			resolveCname: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
		},
		rdap: { rdapLocator: async () => undefined },
		assertPublicHost: async () => undefined,
		now: () => new Date(),
		fetch: async () => new Response(state === "decoy" ? `<html><body>${templatePage(4, () => "bakery", () => "b")}</body></html>` : KIT("now"), { headers: { "content-type": "text/html" } }),
	};
}

/** A mail relay that records every message as the real one does. */
function relay() {
	const sent: Array<Parameters<typeof sendAbuseEmailRoute>[0]> = [];
	const send = (async (params) => {
		sent.push(params);
		const messageId = await AbuseRepository.createOutboundMail({
			reportId: params.reportId, routeId: params.routeId, runId: params.runId, fromAddress: "support@phishing.support", toAddresses: [params.recipient], subject: params.subject, textBody: params.body,
			messageId: `<esc-${sent.length}@phishing.support>`, replyAddress: `abuse-esc${sent.length}@reply.phishing.support`, correlationKey: params.correlationKey, rawArtifactId: null as never, attachmentArtifactIds: [],
		});
		await AbuseRepository.settleOutboundMail({ messageId, status: "sent" });
		return { messageId, status: "sent", rfcMessageId: `<esc-${sent.length}@phishing.support>` };
	}) as typeof sendAbuseEmailRoute;
	return { sent, send };
}

/**
 * A phishing site impersonating PayPal, reported on SENT to its host by mail
 * (with the host's parent network and upstream transit provider as fallback
 * contacts) and to its registrar through the registrar's form. Neither acted.
 */
async function reported() {
	const db = await getDb();
	const submissionId = generateId();
	const hops = [{ index: 0, url: URL_, hostname: DOMAIN, status: 200, contentCaptured: true, bodyCaptured: true }];
	await SubmissionsEntity.create({ id: submissionId, kind: "website", dedupeKey: `esc-${submissionId}`, status: "reported", data: { kind: "website", website: { url: URL_, routes: [{ hops, siteAssessments: [{ finding: "phishing", phishingBasis: "credential_form", hopIndex: 0, judgedHopIndex: 0 }] as never }] } } });
	await ArtifactsEntity.saveBuffer({ submissionId, name: "chain-hop-0.html", kind: "website_hop_body", buffer: Buffer.from(KIT("at-report")) });
	const request = await validateAbuseReportRequest({ targets: [DOMAIN], allegationCategory: "phishing", description: "PayPal credential phishing.", legalBrandUrl: "https://www.paypal.com/", observedUrls: [{ target: DOMAIN, urls: [URL_] }] });
	const { reportId } = await AbuseRepository.createReport({ request, submissionId, reporter: {} });
	db.delete(abuseJobs).where(eq(abuseJobs.reportId, reportId)).run();
	const [target] = await AbuseRepository.listTargets(reportId);
	await AbuseRepository.setTargetResolution({ targetId: target!.id, status: "resolved", resolverSnapshot: {} });
	const route = (params: { key: string; name: string; type: "email" | "provider_submission"; email?: string; provenance: Record<string, unknown> }) => {
		const id = generateId();
		db.insert(abuseProviderRoutes).values({ id, reportId, targetId: target!.id, routeKey: `${params.key}:${id}`, providerRegistryKey: params.key, providerDisplayName: params.name, routeType: params.type, verifiedEmail: params.email ?? null, resolverProvenance: params.provenance, resolutionSnapshot: {}, status: params.type === "email" ? "awaiting_provider_reply" : "submitted", createdAt: SENT, updatedAt: SENT }).run();
		db.insert(abuseProviderRuns).values({ id: generateId(), reportId, routeId: id, providerPayload: {}, payloadHash: String(id), correlationKey: `run:${id}`, attemptCount: 1, executionStatus: params.type === "email" ? "delivered" : "completed", confirmationId: params.type === "email" ? null : "NS-4471", createdAt: SENT, updatedAt: SENT }).run();
		db.insert(abuseEvents).values({ id: generateId(), reportId, routeId: id, eventType: "route.status_changed", data: { to: params.type === "email" ? "awaiting_provider_reply" : "submitted" }, createdAt: SENT }).run();
		return id;
	};
	const host = route({
		key: "email", name: "Example Hosting B.V.", type: "email", email: "abuse@hosting.example",
		provenance: { source: "ip_rdap", email: "abuse@hosting.example", fallbackContacts: [
			{ email: "noc@transit.example", source: "upstream_asn_rdap", organization: "Transit Carrier", transit: { upstreamAsn: 174, customerAsn: 64500, customerOrganization: "Example Hosting B.V." } },
			{ email: "abuse@parent-net.example", source: "ip_rdap", organization: "Parent Net" },
		] },
	});
	db.insert(abuseMailMessages).values({ id: generateId(), reportId, routeId: host, direction: "outbound", kind: "report", status: "sent", fromAddress: "support@phishing.support", toAddresses: ["abuse@hosting.example"], subject: `[Phishing Support] Abuse report for ${DOMAIN}`, textBody: "report", replyAddress: "abuse-r1@reply.phishing.support", messageId: "<report-1@phishing.support>", correlationKey: `email-run:${host}`, occurredAt: SENT }).run();
	const registrar = route({ key: "namesilo", name: "NameSilo Phishing Report", type: "provider_submission", provenance: { source: "registrar_rdap" } });
	await recordSiteCheck({ reportId, targetId: target!.id }, { url: URL_, state: "online", detail: "HTTP 200.", httpStatus: 200, finalUrl: URL_, resolvedAddresses: ["203.0.113.10"], hosting: { addresses: [{ ip: "203.0.113.10", asn: 64500, holder: "EXAMPLE-HOSTING" }] }, domainStatuses: [], pageFingerprints: null, checkedAt: day(1) });
	return { reportId, targetId: target!.id, host, registrar };
}

const steps = async (reportId: bigint) => (await AbuseRepository.listEvents(reportId)).filter((event) => event.eventType === ESCALATION_EVENT).map((event) => `${(event.data as { step: string }).step}${event.routeId ? `@${event.routeId}` : ""}:${(event.data as { action: string }).action}`);
const queued = async (targetId: bigint) => (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.dedupeKey, escalationJobKey(targetId))).all().filter((job) => job.status === "queued").map((job) => job.nextAttemptAt);
const routes = async (reportId: bigint): Promise<AbuseProviderRoute[]> => AbuseRepository.listRoutes(reportId);

/** Run the target's escalation as the worker does: its queued job, if any, runs and is completed. */
async function work(targetId: bigint, dependencies: EscalationDependencies): Promise<void> {
	const db = await getDb();
	const job = db.select().from(abuseJobs).where(eq(abuseJobs.dedupeKey, escalationJobKey(targetId))).all().find((candidate) => candidate.status === "queued");
	if (job) db.update(abuseJobs).set({ status: "running" }).where(eq(abuseJobs.id, job.id)).run();
	await runEscalation({ targetId, ...(job ? { jobId: job.id } : {}) }, dependencies);
	if (job) db.update(abuseJobs).set({ status: "completed" }).where(eq(abuseJobs.id, job.id)).run();
}

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
		expect(cert.body).toContain("- Example Hosting B.V. (host, abuse@hosting.example): reported 20 Nov 2026 10:00 UTC; no action so far.");
		expect(cert.body).toContain("- NameSilo (registrar): reported 20 Nov 2026 10:00 UTC, reference NS-4471; no action so far.");
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
	});

	test("a site taken down holds the ladder; a page that cannot be confirmed is looked at again a day later", async () => {
		const { reportId, targetId } = await reported();
		const { sent, send } = relay();
		await work(targetId, { verify: { site: site("gone"), isShared: async () => false }, send, now: () => day(2) });
		expect(await steps(reportId)).toEqual([]);
		expect(sent).toEqual([]);
		const held = (await AbuseRepository.listEvents(reportId)).filter((event) => event.eventType === ESCALATION_HELD_EVENT);
		expect(held.map((event) => event.data)).toEqual([{ verdict: "gone", tier: "check", checkedAt: expect.any(String), due: ["follow_up", "follow_up"] }]);
		expect(await queued(targetId)).toEqual([]);

		// A browser service failure is not the site's: the job fails and the worker retries it.
		await expect(work(targetId, { verify: { site: site("decoy"), isShared: async () => false, capture: async () => { throw new Error("Browser Fabric session ended"); } }, send, now: () => day(2) })).rejects.toThrow("Browser Fabric session ended");
		// A decoy for every request and every network failing in the browser: unverified, tried again tomorrow.
		const { WebsiteCaptureFailedError, WebsiteUnreachableError } = await import("../../website/archive/errors");
		const failing = async () => { throw new WebsiteCaptureFailedError([new WebsiteUnreachableError("residential", "net::ERR_TIMED_OUT")]); };
		await work(targetId, { verify: { site: site("decoy"), isShared: async () => false, capture: failing }, send, now: () => day(2) });
		expect(await queued(targetId)).toEqual([day(3)]);
		expect(sent).toEqual([]);
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

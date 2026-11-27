import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { ArtifactsEntity } from "../../db/entities/artifacts";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { generateId } from "../../db/ids";
import { recordSiteCheck } from "../../liveness/repository";
import { DAY_MS } from "../../util/date_time";
import { templatePage } from "../../website/test_mhtml";
import { validateAbuseReportRequest } from "../contracts";
import type { sendAbuseEmailRoute } from "../mail/send";
import { AbuseRepository } from "../repository";
import { abuseEvents, jobs, abuseMailMessages, abuseProviderRoutes, abuseProviderRuns } from "../schema";
import { escalationJobKey } from "./ladder";
import { runEscalation, type EscalationDependencies } from "./run";

/** Helpers of the escalation tests: a reported PayPal phishing site nobody acts on, the site as checks see it, a recording mail relay, and the worker. */
export const DOMAIN = "paypal-verify-account.com";
export const URL_ = `https://${DOMAIN}/signin`;
export const SENT = new Date("2026-11-20T10:00:00Z");
export const day = (days: number) => new Date(SENT.getTime() + days * DAY_MS);
const KIT = (token: string) => `<html><body><input type="hidden" name="t" value="${token}">${templatePage(10, (card) => `Confirm your PayPal account ${card} `.repeat(4))}</body></html>`;

/** The site as checks see it: up and serving the kit, or gone. */
export function site(state: "kit" | "gone" | "decoy"): NonNullable<EscalationDependencies["verify"]>["site"] {
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
export function relay() {
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
export async function reported() {
	const db = await getDb();
	const submissionId = generateId();
	const hops = [{ index: 0, url: URL_, hostname: DOMAIN, status: 200, contentCaptured: true, bodyCaptured: true }];
	await SubmissionsEntity.create({ id: submissionId, kind: "website", dedupeKey: `esc-${submissionId}`, status: "reported", data: { kind: "website", website: { url: URL_, routes: [{ hops, siteAssessments: [{ finding: "phishing", phishingBasis: "credential_form", hopIndex: 0, judgedHopIndex: 0 }] as never }] } } });
	await ArtifactsEntity.saveBuffer({ submissionId, name: "chain-hop-0.html", kind: "website_hop_body", buffer: Buffer.from(KIT("at-report")) });
	const request = await validateAbuseReportRequest({ targets: [DOMAIN], allegationCategory: "phishing", description: "PayPal credential phishing.", legalBrandUrl: "https://www.paypal.com/", observedUrls: [{ target: DOMAIN, urls: [URL_] }] });
	const { reportId } = await AbuseRepository.createReport({ request, submissionId, reporter: {} });
	db.delete(jobs).where(eq(jobs.reportId, reportId)).run();
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


/** Run the target's escalation as the worker does: its queued job, if any, runs and is completed. */
export async function work(targetId: bigint, dependencies: EscalationDependencies): Promise<void> {
	const db = await getDb();
	const job = db.select().from(jobs).where(eq(jobs.dedupeKey, escalationJobKey(targetId))).all().find((candidate) => candidate.status === "queued");
	if (job) db.update(jobs).set({ status: "running" }).where(eq(jobs.id, job.id)).run();
	try {
		await runEscalation({ targetId, ...(job ? { jobId: job.id } : {}) }, dependencies);
		if (job) db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, job.id)).run();
	} catch (error) {
		if (job) db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, job.id)).run();
		throw error;
	}
}

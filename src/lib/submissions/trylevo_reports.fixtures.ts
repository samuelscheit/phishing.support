import { eq } from "drizzle-orm";

import { validateAbuseReportRequest } from "@/lib/abuse/contracts";
import { TRYLEVO_MAIL } from "@/lib/abuse/mail/trylevo_mail.fixtures";
import { AbuseRepository } from "@/lib/abuse/repository";
import { abuseArtifacts, abuseEvents, jobs, abuseMailMessages, abuseProviderRoutes, abuseProviderRuns, abuseReports, type AbuseRouteStatus, type AbuseRouteType } from "@/lib/abuse/schema";
import { getDb } from "@/lib/db";
import { generateId } from "@/lib/db/ids";
import { sha256Hex } from "@/lib/util/hash";

/** 2026-11-26 at `time` ("18:51:08") UTC, the day of case 384401854580134038. */
export const trylevoAt = (time: string) => new Date(`2026-11-26T${time}.000Z`);

type Owner = { reportId: bigint; targetId: bigint };

async function report(params: { submissionId: bigint; target: string; url: string; idempotencyKey?: string; createdAt: string; status: "waiting_provider" | "submitted"; evidence: string[] }): Promise<Owner> {
	const request = await validateAbuseReportRequest({ targets: [params.target], observedUrls: [{ target: params.target, urls: [params.url] }], allegationCategory: "malware", description: `Malware distribution at ${params.url}.` });
	const created = await AbuseRepository.createReport({ request, reporter: {} });
	const db = await getDb();
	db.update(abuseReports).set({ submissionId: params.submissionId, idempotencyKey: params.idempotencyKey ?? null, status: params.status, createdAt: trylevoAt(params.createdAt), updatedAt: trylevoAt(params.createdAt) }).where(eq(abuseReports.id, created.reportId)).run();
	// The queued resolution of a report made through the API is not part of this case.
	db.delete(jobs).where(eq(jobs.reportId, created.reportId)).run();
	for (const name of params.evidence) {
		const blob = Buffer.from(name);
		db.insert(abuseArtifacts).values({ id: generateId(), reportId: created.reportId, name, kind: "user_evidence_original", mimeType: name.endsWith(".png") ? "image/png" : "application/json", sha256: sha256Hex(blob), size: blob.length, blob, createdAt: trylevoAt(params.createdAt) }).run();
	}
	const [target] = await AbuseRepository.listTargets(created.reportId);
	return { reportId: created.reportId, targetId: target!.id };
}

async function route(owner: Owner, params: {
	key: string; name: string; type: AbuseRouteType; status: AbuseRouteStatus; email?: string; provenance: Record<string, unknown>;
	run?: { status: "completed" | "delivered" | "unknown_external_state"; confirmationId?: string; confirmationText?: string; at: string };
	changes?: Array<{ to: string; at: string }>;
}): Promise<bigint> {
	const db = await getDb();
	const id = generateId();
	const createdAt = trylevoAt(params.run?.at ?? "18:50:09");
	db.insert(abuseProviderRoutes).values({
		id, reportId: owner.reportId, targetId: owner.targetId, routeKey: `${params.key}:${id}`, providerRegistryKey: params.key, providerDisplayName: params.name,
		routeType: params.type, verifiedEmail: params.email ?? null, resolverProvenance: params.provenance, resolutionSnapshot: {}, status: params.status, createdAt, updatedAt: createdAt,
	}).run();
	if (params.run) {
		db.insert(abuseProviderRuns).values({
			id: generateId(), reportId: owner.reportId, routeId: id, providerPayload: { adapter: params.key }, payloadHash: sha256Hex(String(id)), correlationKey: `run:${id}`, attemptCount: 1,
			executionStatus: params.run.status, confirmationId: params.run.confirmationId ?? null, confirmationText: params.run.confirmationText ?? null, createdAt, updatedAt: createdAt,
		}).run();
	}
	for (const change of params.changes ?? []) {
		db.insert(abuseEvents).values({ id: generateId(), reportId: owner.reportId, routeId: id, eventType: "route.status_changed", data: { to: change.to }, createdAt: trylevoAt(change.at) }).run();
	}
	return id;
}

async function mail(owner: Owner, routeId: bigint, params: {
	id?: bigint; direction: "inbound" | "outbound"; kind: string; at: string; subject: string; body: string; from?: string; to?: string[];
	classification?: "acknowledged" | "rejected"; correlationKey?: string;
}): Promise<bigint> {
	const id = params.id ?? generateId();
	(await getDb()).insert(abuseMailMessages).values({
		id, reportId: owner.reportId, routeId, direction: params.direction, kind: params.kind, status: params.direction === "outbound" ? "sent" : "received",
		fromAddress: params.from ?? null, toAddresses: params.to ?? [], subject: params.subject, textBody: params.body, classification: params.classification ?? null,
		correlationKey: params.correlationKey ?? null, occurredAt: trylevoAt(params.at),
	}).run();
	return id;
}

async function job(owner: Owner, routeId: bigint, jobType: "find_provider_receipt" | "poll_provider_correspondence", at: string) {
	(await getDb()).insert(jobs).values({ id: generateId(), jobType, reportId: owner.reportId, routeId, status: "queued", nextAttemptAt: trylevoAt(at), payload: {} }).run();
}

const status = (key: string, routeId: bigint, state: string) => `provider-api:${key}:status:${routeId}:${state}`;

/**
 * The reports of case 384401854580134038 as they stood at 19:06 UTC: the
 * site (Cloudflare restricted it and named its host, NameSilo took the
 * report, Netcraft's scan found nothing, the host named by Cloudflare is
 * awaiting a reply) and the payload host (Eranet reviewing, Cloudflare's
 * answer lost behind an HTTP 504 with a receipt lookup queued, Netcraft
 * found nothing).
 */
export async function seedTrylevoReports(submissionId: bigint): Promise<{ site: Owner; payloadHost: Owner }> {
	const site = await report({ submissionId, target: "trylevo.app", url: "https://trylevo.app/", createdAt: "18:50:04", status: "waiting_provider", evidence: ["website-step2.png", "website.png", "payload-20dd8401db3f831b.json"] });
	const cloudflare = await route(site, {
		key: "cloudflare", name: "Cloudflare Abuse", type: "provider_submission", status: "submitted", email: "abuse@cloudflare.com", provenance: { source: "domain_infrastructure_ip" },
		run: { status: "completed", confirmationId: "983629f3ca31bae5", confirmationText: "Cloudflare accepted the phishing abuse report.", at: "18:50:10" },
		changes: [{ to: "running", at: "18:50:10" }, { to: "submitted", at: "18:50:12" }],
	});
	await mail(site, cloudflare, { direction: "inbound", kind: "provider_api", at: "18:50:22", subject: "983629f3ca31bae5: Abuse Report Confirmation", body: TRYLEVO_MAIL.cloudflareConfirmation, from: "Cloudflare Abuse", correlationKey: "provider-api:cloudflare:d61efdd3" });
	await mail(site, cloudflare, { direction: "inbound", kind: "provider_api", at: "18:51:13", subject: "Report status: submitted", body: "", from: "Cloudflare Abuse", correlationKey: status("cloudflare", cloudflare, "submitted") });
	const response = await mail(site, cloudflare, { direction: "inbound", kind: "provider_api", at: "19:00:46", subject: "[983629f3ca31bae5]: Response to your Phishing report", body: TRYLEVO_MAIL.cloudflareRestricted, from: "Cloudflare Abuse", correlationKey: "provider-api:cloudflare:2f28c335" });
	await mail(site, cloudflare, { direction: "inbound", kind: "provider_api", at: "19:05:12", subject: "Report status: accepted", body: "", from: "Cloudflare Abuse", classification: "acknowledged", correlationKey: status("cloudflare", cloudflare, "accepted") });
	await job(site, cloudflare, "poll_provider_correspondence", "20:05:12");

	const host = await route(site, {
		key: "origin-host-email", name: "Sollutium-NL - SOLLUTIUM EU Sp z.o.o., PL", type: "email", status: "awaiting_provider_reply", email: "abuse-ams@v-sys.org",
		provenance: { source: "cloudflare_origin_disclosure", sourceMessageId: String(response) },
		run: { status: "delivered", at: "19:05:16" }, changes: [{ to: "awaiting_provider_reply", at: "19:05:18" }],
	});
	await mail(site, host, { direction: "outbound", kind: "report", at: "19:05:18", subject: "[Phishing Support] [PS-b7e34e00101c] Malware abuse: malware distribution site for trylevo.app (Cloudflare report 983629f3ca31bae5)", body: TRYLEVO_MAIL.sollutiumReport, from: "support@phishing.support", to: ["abuse-ams@v-sys.org"], correlationKey: `email-run:${host}` });

	await route(site, {
		key: "namesilo", name: "NameSilo Phishing Report", type: "provider_submission", status: "submitted", email: "abuse@namesilo.com", provenance: { source: "registrar_rdap" },
		run: { status: "completed", confirmationText: "NameSilo accepted the phishing report.", at: "18:50:08" }, changes: [{ to: "submitted", at: "18:52:03" }],
	});
	const netcraft = await route(site, {
		key: "netcraft", name: "Netcraft", type: "provider_submission", status: "submitted", provenance: { source: "provider_supplemental_target_rule" },
		run: { status: "completed", confirmationId: "B7nnhdCJv4yA4vbQKULKY9Uyns6TakMs", confirmationText: "Successfully reported", at: "18:50:08" }, changes: [{ to: "submitted", at: "18:50:20" }],
	});
	await mail(site, netcraft, { direction: "inbound", kind: "notification", at: "18:50:21", subject: "Thanks for your report", body: TRYLEVO_MAIL.netcraftThanks, from: "report-updates@netcraft.com", classification: "acknowledged" });
	await mail(site, netcraft, { direction: "inbound", kind: "provider_api", at: "18:51:12", subject: "Report status: processing", body: "", from: "Netcraft", correlationKey: status("netcraft", netcraft, "processing") });
	await mail(site, netcraft, { direction: "inbound", kind: "notification", at: "19:00:26", subject: "We've finished analysing your submission", body: TRYLEVO_MAIL.netcraftNoThreat, from: "report-updates@netcraft.com", classification: "rejected" });

	const payloadHost = await report({ submissionId, target: "hostsync.pro", url: "https://hostsync.pro/hgp03m/LNcf8Kpm6qWr", idempotencyKey: `payload-host:${submissionId}:ebbb4a21c013e8ad1dfe4ddb89ffa2e3`, createdAt: "18:50:06", status: "submitted", evidence: ["malware-payload-evidence.json", "lure-page.png"] });
	const eranet = await route(payloadHost, {
		key: "eranet", name: "Eranet Fraud & Phishing Report", type: "provider_submission", status: "submitted", provenance: { source: "domain_rdap" },
		run: { status: "completed", confirmationId: "e8a998e9-ed1c-449c-a426-de1c6c183154", confirmationText: "Eranet accepted the report (receipt e8a998e9-ed1c-449c-a426-de1c6c183154).", at: "18:50:09" }, changes: [{ to: "submitted", at: "18:50:52" }],
	});
	await mail(payloadHost, eranet, { direction: "inbound", kind: "provider_api", at: "18:51:54", subject: "Report status: material auditing", body: "", from: "Eranet", correlationKey: status("eranet", eranet, "material auditing") });
	await job(payloadHost, eranet, "poll_provider_correspondence", "20:05:14");
	const lost = await route(payloadHost, {
		key: "cloudflare", name: "Cloudflare Abuse", type: "provider_submission", status: "unknown_external_state", email: "abuse@cloudflare.com", provenance: { source: "domain_infrastructure_ip" },
		run: { status: "unknown_external_state", at: "18:50:53" }, changes: [{ to: "running", at: "18:50:53" }],
	});
	await job(payloadHost, lost, "find_provider_receipt", "19:20:53");
	const netcraftHost = await route(payloadHost, {
		key: "netcraft", name: "Netcraft", type: "provider_submission", status: "submitted", provenance: { source: "provider_supplemental_target_rule" },
		run: { status: "completed", confirmationId: "bBcsuHcDjgHGckx13NQPQQkvWGAyfzB6", confirmationText: "Successfully reported", at: "18:50:09" }, changes: [{ to: "submitted", at: "18:51:11" }],
	});
	await mail(payloadHost, netcraftHost, { direction: "inbound", kind: "notification", at: "18:51:12", subject: "Thanks for your report", body: TRYLEVO_MAIL.netcraftThanks, from: "report-updates@netcraft.com", classification: "acknowledged" });
	await mail(payloadHost, netcraftHost, { direction: "inbound", kind: "provider_api", at: "18:52:11", subject: "Report status: processing", body: "", from: "Netcraft", correlationKey: status("netcraft", netcraftHost, "processing") });
	await mail(payloadHost, netcraftHost, { direction: "inbound", kind: "notification", at: "18:59:42", subject: "We've finished analysing your submission", body: TRYLEVO_MAIL.netcraftNoThreat.replace("18:50 UTC", "18:51 UTC").replace("19:00 UTC", "18:59 UTC"), from: "report-updates@netcraft.com", classification: "rejected" });
	return { site, payloadHost };
}

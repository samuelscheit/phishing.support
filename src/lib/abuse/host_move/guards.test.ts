import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { CampaignRepository } from "@/lib/campaign/repository";
import { confirmedCase } from "@/lib/campaign/test_sites";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { getDb } from "@/lib/db";
import { generateId } from "@/lib/db/ids";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { moveProofFiles } from "@/lib/liveness/host_move";
import { networkLookup } from "@/lib/liveness/host_move.fixtures";
import { attributeHosting, hostingChange } from "@/lib/liveness/hosting";
import { HOST_MOVE_ACTION_EVENT, HOST_MOVED_EVENT, type HostMove } from "@/lib/liveness/moves";
import { listSiteChecksForTargets, recordSiteCheck } from "@/lib/liveness/repository";
import { trylevoAt } from "@/lib/submissions/trylevo_reports.fixtures";
import { sha256Hex } from "@/lib/util/hash";
import { AbuseRepository } from "../repository";
import { abuseJobs, abuseMailMessages, abuseProviderRoutes, abuseProviderRuns, abuseReports } from "../schema";
import { hostMoveNotice } from "./notice";
import { reportHostMove } from "./report";
import { check, DEMO_JS, events, jobs, nextCheckAt, recordingSend, reportedAt, resolving, site, trylevo } from "./report.fixtures";

useTemporaryDatabase();

const day = (date: string) => new Date(`2026-11-${date}Z`);
const moveKinds = async (reportId: bigint) => (await events(reportId, HOST_MOVED_EVENT)).map((event) => {
	const data = event.data as HostMove;
	return `${data.from.name}->${data.to.name}:${data.content}`;
});
const actions = async (reportId: bigint) => (await events(reportId, HOST_MOVE_ACTION_EVENT)).map((event) => (event.data as { action: string }).action);
const actOn = async (reportId: bigint, index: number, dependencies: Parameters<typeof reportHostMove>[1]) => {
	const job = (await jobs("report_host_move"))[index];
	await reportHostMove({ reportId, key: String(job!.payload!.key) }, dependencies);
};

/** A route of the report, inserted as production stores one, with its run and the mail it sent. */
async function emailRoute(owner: { reportId: bigint; targetId: bigint }, params: { email: string; name: string; source: string; status: string; mail?: Array<{ direction: "inbound" | "outbound"; subject: string; at: string; key?: string; replyAddress?: string }> }) {
	const db = await getDb();
	const id = generateId();
	db.insert(abuseProviderRoutes).values({ id, reportId: owner.reportId, targetId: owner.targetId, routeKey: `email:${params.email}`, providerRegistryKey: `email:${params.email.split("@")[1]}`, providerDisplayName: params.name, routeType: "email", verifiedEmail: params.email, resolverProvenance: { source: params.source }, resolutionSnapshot: {}, status: params.status as never }).run();
	const runId = generateId();
	db.insert(abuseProviderRuns).values({ id: runId, reportId: owner.reportId, routeId: id, providerPayload: {}, payloadHash: String(id), correlationKey: `email-run:${id}`, executionStatus: "delivered" }).run();
	for (const message of params.mail ?? []) {
		db.insert(abuseMailMessages).values({
			id: generateId(), reportId: owner.reportId, routeId: id, runId, direction: message.direction, kind: message.direction === "outbound" ? "report" : "reply", status: message.direction === "outbound" ? "sent" : "received",
			subject: message.subject, textBody: "…", correlationKey: message.key === "report" ? `email-run:${id}` : message.key ?? null, replyAddress: message.replyAddress ?? null, occurredAt: new Date(message.at),
		}).run();
	}
	return id;
}

describe("a site flapping between two hosts (al-tawaqal-poultry-farm.pro, AS57043 ↔ AS26666, 21–24 Nov)", () => {
	test("moves once: a return to a network seen since the report, and a second visit there, are no moves", async () => {
		const { reportId, targetId, domain } = await reportedAt("147.90.13.47", 57043, "HOSTKEY B.V.");
		await check(targetId, site(["153.75.235.103"], day("27T08:00:00"), { domain }));
		await check(targetId, site(["147.90.13.47"], day("27T09:00:00"), { domain }));
		await check(targetId, site(["153.75.235.103"], day("28T08:00:00"), { domain }));
		await check(targetId, site(["147.90.13.47"], day("29T08:00:00"), { domain }));
		expect(await moveKinds(reportId)).toEqual(["HOSTKEY->INTERSERVER-LAX:served"]);
		expect(await jobs("report_host_move")).toHaveLength(1);
	});

	test("an address the site resolved to before checks recorded networks is no move either (the production checks of 21–24 Nov)", async () => {
		const { reportId, targetId, domain } = await reportedAt("147.90.13.47", 57043, "HOSTKEY B.V.");
		// As stored before this release: the addresses without their networks.
		for (const [at, ip] of [["21T14:03:42", "153.75.235.103"], ["21T19:03:41", "147.90.13.47"], ["22T13:03:41", "147.90.13.47"], ["24T13:03:41", "153.75.235.103"]] as const) {
			await recordSiteCheck({ reportId, targetId }, { url: `https://${domain}/`, state: "online", resolvedAddresses: [ip], domainStatuses: [], checkedAt: day(at) });
		}
		await check(targetId, site(["153.75.235.103"], day("28T13:03:41"), { domain }));
		expect(await moveKinds(reportId)).toEqual([]);
		// A network never seen since the report still is one; it moved from where the last check found it.
		await check(targetId, site(["5.161.1.1"], day("29T13:03:41"), { domain }));
		expect(await moveKinds(reportId)).toEqual(["INTERSERVER-LAX->HETZNER-CLOUD2-AS:served"]);
	});

	test("the hourly recheck after a move is not chained when the recheck itself finds another move", async () => {
		const { reportId, targetId, domain } = await reportedAt("5.161.1.1", 213230, "Hetzner Online GmbH");
		await check(targetId, site(["85.137.52.128"], day("27T08:00:00"), { domain }));
		expect(await nextCheckAt(targetId)).toEqual([day("27T09:00:00")]);
		await check(targetId, site(["151.101.1.195"], day("27T09:00:00"), { domain }));
		expect(await moveKinds(reportId)).toEqual(["Hetzner Online GmbH->Sollutium-NL:served", "Sollutium-NL->Fastly:served"]);
		const [next] = await nextCheckAt(targetId);
		expect(next!.getTime() - day("27T09:00:00").getTime()).toBeGreaterThan(3_600_000);
	});

	test("at most two moves of a target are acted on, and only while the move is where the site stands", async () => {
		const { reportId, targetId, domain } = await reportedAt("5.161.1.1", 213230, "Hetzner Online GmbH");
		await check(targetId, site(["85.137.52.128"], day("27T08:00:00"), { domain }));
		await check(targetId, site(["151.101.1.195"], day("27T09:00:00"), { domain }));
		await check(targetId, site(["23.215.0.136"], day("28T08:00:00"), { domain }));
		expect(await jobs("report_host_move")).toHaveLength(3);
		const { send } = recordingSend();
		// The first move is no longer where the site is: nothing is sent for it.
		await actOn(reportId, 0, { resolveIp: resolving("abuse-ams@v-sys.org", 43641).resolveIp, send });
		// The third is where it is, but two moves came before it.
		await actOn(reportId, 2, { resolveIp: resolving("abuse@akamai.com", 20940).resolveIp, send });
		expect(await actions(reportId)).toEqual(["not_current", "limit_reached"]);
		expect(await AbuseRepository.listRoutes(reportId)).toEqual([]);
	});

	test("a route told about a move this week is not told about the next one", async () => {
		const owner = await trylevo();
		const { sent, send } = recordingSend();
		await check(owner.targetId, site(["85.137.52.128"], trylevoAt("21:30:05")));
		await actOn(owner.reportId, 0, { resolveIp: resolving("abuse-ams@v-sys.org", 43641).resolveIp, send });
		expect(sent.map(({ recipient }) => recipient)).toEqual(["abuse-ams@v-sys.org", "abusereply@cloudflare.com"]);
		// V-SYS again, from another of its networks a day later.
		await check(owner.targetId, site(["88.198.1.1"], new Date("2026-11-27T21:30:00Z")));
		await actOn(owner.reportId, 1, { resolveIp: resolving("abuse-ams@v-sys.org", 24940).resolveIp, send });
		expect(sent).toHaveLength(2);
		expect((await events(owner.reportId, HOST_MOVE_ACTION_EVENT)).map((event) => (event.data as { role: string; action: string })).map(({ role, action }) => `${role}:${action}`).slice(3)).toEqual(["host:throttled", "registrar:no_channel"]);
	});
});

describe("what proves the moved site is the reported one", () => {
	const KIT = "a".repeat(64);
	const capture = (resources: Array<{ url: string; mimeType: string; sha256: string }>) => ({ url: "https://levo-kit.app/", kitResources: resources.map((resource) => ({ ...resource, size: 40_000 })) });

	test("only the site's own scripts and frames: no stylesheet, no other host, no library by name or by what the database knows of the hash", async () => {
		const id = 384500000000000101n;
		const hashes = { kit: KIT, jquery: "b".repeat(64), style: "c".repeat(64), other: "d".repeat(64), published: "e".repeat(64), wp: "f".repeat(64) };
		await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: capture([
			{ url: "https://levo-kit.app/js/app.js?v=3", mimeType: "application/javascript", sha256: hashes.kit },
			{ url: "https://levo-kit.app/public/assets/js/jquery.js", mimeType: "application/javascript", sha256: hashes.jquery },
			{ url: "https://levo-kit.app/css/site.css", mimeType: "text/css", sha256: hashes.style },
			{ url: "https://cdn.levo-other.app/kit.js", mimeType: "application/javascript", sha256: hashes.other },
			{ url: "https://levo-kit.app/js/vendor-bundle.js", mimeType: "application/javascript", sha256: hashes.published },
			{ url: "https://levo-kit.app/wp-includes/js/wp-embed.min.js", mimeType: "application/javascript", sha256: hashes.wp },
		]) }, dedupeKey: "website-kit-proof", status: "reported" });
		await CampaignRepository.saveKitHashCheck(hashes.published, "npm:some-bundle@1.0.0/dist/bundle.js");
		expect(await moveProofFiles({ submissionId: id, host: "levo-kit.app", reportId: 1n })).toEqual([{ path: "/js/app.js?v=3", sha256: hashes.kit, kind: "script" }]);
		expect(await moveProofFiles({ submissionId: null, host: "levo-kit.app", reportId: 1n })).toEqual([]);
	});

	test("a hash recorded for sites on more unrelated domains than one kit reaches is shared", async () => {
		const hash = "9".repeat(64);
		for (const [index, host] of ["one-shared.app", "two-shared.app", "three-shared.app"].entries()) {
			const [member] = await confirmedCase(384500000000000200n + BigInt(index), { url: `https://${host}/` });
			await CampaignRepository.recordIndicators(member!, [{ kind: "kit_fingerprint", value: hash, links: true, evidence: { fileKind: "script", url: `https://${host}/app.js` } }]);
		}
		expect(await CampaignRepository.isSharedKitFile(hash, 1n)).toBe(true);
		expect(await CampaignRepository.isSharedKitFile("8".repeat(64), 1n)).toBe(false);
		// Set aside as a library or platform file when the sites were linked.
		const [member] = await confirmedCase(384500000000000300n, { url: "https://library-user.app/" });
		await CampaignRepository.recordIndicators(member!, [{ kind: "kit_fingerprint", value: "7".repeat(64), links: false, evidence: { fileKind: "script", library: "npm:jquery@3.7.1/dist/jquery.min.js" } }]);
		expect(await CampaignRepository.isSharedKitFile("7".repeat(64), 1n)).toBe(true);
	});

	test("a match counts only while the check finds the site up; otherwise the content is unknown and nothing is reported", async () => {
		const { reportId, targetId, domain } = await reportedAt("5.161.1.1", 213230, "Hetzner Online GmbH");
		await check(targetId, site(["85.137.52.128"], day("27T08:00:00"), { domain, page: 404 }));
		expect(await moveKinds(reportId)).toEqual(["Hetzner Online GmbH->Sollutium-NL:unknown"]);
		expect(await jobs("report_host_move")).toEqual([]);
		// No captured file of the kit to compare: unknown too.
		const other = await reportedAt("5.161.1.1", 213230, "Hetzner Online GmbH");
		await check(other.targetId, { ...site(["85.137.52.128"], day("27T08:00:00"), { domain }), proofFiles: async () => [] });
		expect(await moveKinds(other.reportId)).toEqual(["Hetzner Online GmbH->Sollutium-NL:unknown"]);
	});
});

describe("recording and acting survive failures", () => {
	test("a move confirmed before a crash that lost its job is queued by the next check", async () => {
		const owner = await trylevo();
		await check(owner.targetId, site(["85.137.52.128"], trylevoAt("21:30:05")));
		(await getDb()).delete(abuseJobs).where(eq(abuseJobs.jobType, "report_host_move")).run();
		await check(owner.targetId, site(["85.137.52.128"], trylevoAt("22:30:05")));
		expect((await jobs("report_host_move")).map((job) => job.payload?.key)).toEqual([`${owner.targetId}->as:43641`]);
		expect(await events(owner.reportId, HOST_MOVED_EVENT)).toHaveLength(1);
	});

	test("a check whose network lookup failed does not hide the move from the next one", async () => {
		const owner = await trylevo();
		await check(owner.targetId, { ...site(["85.137.52.128"], trylevoAt("19:50:04")), network: async () => { throw new Error("RIPEstat timed out"); } });
		expect((await listSiteChecksForTargets([owner.targetId]))[0]!.hosting?.addresses).toEqual([{ ip: "85.137.52.128" }]);
		expect(await events(owner.reportId, HOST_MOVED_EVENT)).toEqual([]);
		await check(owner.targetId, site(["85.137.52.128"], trylevoAt("21:30:05")));
		expect(await moveKinds(owner.reportId)).toEqual(["Cloudflare->Sollutium-NL:served"]);
	});

	test("a notice the relay refused is on record as failed and sent by the job's retry", async () => {
		const owner = await trylevo();
		await check(owner.targetId, site(["85.137.52.128"], trylevoAt("21:30:05")));
		const ip = resolving("abuse-ams@v-sys.org", 43641).resolveIp;
		await expect(actOn(owner.reportId, 0, { resolveIp: ip, send: recordingSend({ refuse: "550 5.7.1 rejected" }).send })).rejects.toThrow("550 5.7.1 rejected");
		expect(await actions(owner.reportId)).toEqual(["failed"]);
		const { sent, send } = recordingSend();
		await actOn(owner.reportId, 0, { resolveIp: ip, send });
		expect(sent.map(({ recipient }) => recipient)).toEqual(["abuse-ams@v-sys.org", "abusereply@cloudflare.com"]);
		expect(await actions(owner.reportId)).toEqual(["failed", "followed_up", "followed_up", "no_channel"]);
	});

	test("nothing is sent on a report canceled since the move", async () => {
		const owner = await trylevo();
		await check(owner.targetId, site(["85.137.52.128"], trylevoAt("21:30:05")));
		(await getDb()).update(abuseReports).set({ status: "canceled" }).where(eq(abuseReports.id, owner.reportId)).run();
		const { sent, send } = recordingSend();
		await actOn(owner.reportId, 0, { resolveIp: resolving("abuse-ams@v-sys.org", 43641).resolveIp, send });
		expect(sent).toEqual([]);
		expect(await actions(owner.reportId)).toEqual([]);
	});
});

describe("whom the new host's report goes to", () => {
	test("a fallback contact of the new address is not its host: a route to that mailbox gets no follow-up", async () => {
		const owner = await trylevo();
		await check(owner.targetId, site(["5.161.1.1"], trylevoAt("21:30:05")));
		const { sent, send } = recordingSend();
		await actOn(owner.reportId, 0, { resolveIp: resolving("abuse@hetzner.example", 213230, ["abuse-ams@v-sys.org"]).resolveIp, send });
		expect(sent.map(({ recipient }) => recipient)).toEqual(["abusereply@cloudflare.com"]);
		expect((await AbuseRepository.listRoutes(owner.reportId)).map((route) => route.verifiedEmail)).toContain("abuse@hetzner.example");
	});

	test("the new host's contact on a route that never went out is not reported, and the CDN is not told it was", async () => {
		const owner = await trylevo();
		await emailRoute(owner, { email: "abuse@hetzner.example", name: "Hetzner", source: "domain_infrastructure_ip", status: "discarded" });
		await check(owner.targetId, site(["5.161.1.1"], trylevoAt("21:30:05")));
		const { sent, send } = recordingSend();
		await actOn(owner.reportId, 0, { resolveIp: resolving("abuse@hetzner.example", 213230).resolveIp, send });
		expect((await events(owner.reportId, HOST_MOVE_ACTION_EVENT)).map((event) => event.data as { action: string; status?: string }).find(({ action }) => action === "not_sent")).toMatchObject({ status: "discarded" });
		expect(await jobs("send_email")).toEqual([]);
		const cloudflare = sent.find(({ recipient }) => recipient === "abusereply@cloudflare.com")!;
		expect(cloudflare.body).not.toContain("We have told the new host");
	});

	test("a registrar that answered by mail is written to in its own ticket, on the route's reply address", async () => {
		const owner = await reportedAt("147.90.13.47", 57043, "HOSTKEY B.V.");
		await emailRoute(owner, {
			email: "abuse@ownregistrar.example", name: "OwnRegistrar Inc", source: "registrar_rdap", status: "provider_rejected",
			mail: [
				{ direction: "outbound", subject: "[Phishing Support] [PS-f8a80d0010c1] Abuse report for levo-mac.com", at: "2026-11-21T13:03:53Z", key: "report", replyAddress: "abuse-abc@reply.phishing.support" },
				{ direction: "inbound", subject: "Re:[## 599572 ##] [Phishing Support] [PS-f8a80d0010c1] Abuse report for levo-mac.com", at: "2026-11-22T08:05:02Z" },
			],
		});
		await check(owner.targetId, site(["5.161.1.1"], day("27T08:00:00"), { domain: owner.domain }));
		const { sent, send } = recordingSend();
		await actOn(owner.reportId, 0, { resolveIp: resolving("abuse@hetzner.example", 213230).resolveIp, send });
		expect(sent.map(({ recipient, subject, replyAddress }) => ({ recipient, subject, replyAddress }))).toEqual([
			{ recipient: "abuse@ownregistrar.example", subject: "Re:[## 599572 ##] [Phishing Support] [PS-f8a80d0010c1] Abuse report for levo-mac.com", replyAddress: "abuse-abc@reply.phishing.support" },
		]);
	});
});

describe("the notice's recipe", () => {
	test("repeats the request exactly as captured: scheme, port and query string", () => {
		const move: HostMove = {
			key: "1->as:43641", targetId: "1", at: "2026-11-27T08:00:00.000Z", since: "2026-11-26T19:00:00.000Z", kind: "new_network", content: "served",
			from: { name: "Hetzner", asn: 213230, addresses: ["5.161.1.1"] },
			to: { name: "Sollutium-NL", asn: 43641, addresses: ["2a0e:6a80::7"] },
			evidence: { url: "http://levo-kit.app/", state: "online", httpStatus: 200, kitFiles: [{ url: "http://levo-kit.app:8080/js/app.js?v=3", sha256: sha256Hex(DEMO_JS) }] },
		};
		const text = hostMoveNotice({ move, domain: "levo-kit.app", allegation: "phishing", greeting: "Hello Sollutium-NL Abuse Team," });
		expect(text).toContain("as of 27 Nov 2026 08:00 UTC it resolves to 2a0e:6a80::7, in your network AS43641, and that server serves the reported site; on 26 Nov 2026 19:00 UTC it still resolved to 5.161.1.1, in AS213230.");
		expect(text).toContain("  curl -s --resolve 'levo-kit.app:8080:[2a0e:6a80::7]' 'http://levo-kit.app:8080/js/app.js?v=3' | sha256sum");
		expect(text).not.toContain("openssl");
	});
});

describe("edges and organisations", () => {
	test("Akamai's networks are one CDN, Google's front ends an edge, a platform named by its answer one too", async () => {
		const attributed = (ips: string[], server?: string) => attributeHosting({ addresses: ips.map((ip) => ({ ip })), ...(server ? { server } : {}) }, undefined, networkLookup());
		expect(hostingChange(await attributed(["23.215.0.136"]), await attributed(["2.16.1.1"]))).toBeUndefined();
		expect(hostingChange(await attributed(["5.161.1.1"]), await attributed(["34.120.1.1"]))).toMatchObject({ kind: "new_cdn", to: { name: "Google", cdn: "Google" } });
		expect((await attributed(["76.76.21.21"], "Vercel")).addresses).toEqual([{ ip: "76.76.21.21", asn: 16509, holder: "AMAZON-02 - Amazon.com, Inc., US", prefix: "76.76.21.0/24", cdn: "Vercel" }]);
		expect((await attributed(["76.76.21.21"], "nginx")).addresses[0]!.cdn).toBeUndefined();
		// Two networks of one company are one host.
		expect(hostingChange(await attributed(["5.161.1.1"]), await attributed(["88.198.1.1"]))).toBeUndefined();
	});
});

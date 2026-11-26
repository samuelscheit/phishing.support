import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { TRYLEVO_ROUTED_SNAPSHOT } from "@/lib/liveness/host_move.fixtures";
import { HOST_MOVE_ACTION_EVENT, HOST_MOVED_EVENT, hostMovesOf } from "@/lib/liveness/moves";
import { listSiteChecksForTargets, livenessJobKey, recordSiteCheck } from "@/lib/liveness/repository";
import { checkSoonAfter, scheduleLivenessChecks } from "@/lib/liveness/schedule";
import { getReportsForSubmission } from "@/lib/submissions/abuse_details";
import { nextStep, rankedRoutes, takedownSummary } from "@/lib/submissions/report_view";
import { trylevoAt } from "@/lib/submissions/trylevo_reports.fixtures";
import { TRYLEVO_MAIL } from "../mail/trylevo_mail.fixtures";
import { AbuseRepository } from "../repository";
import { abuseArtifacts, abuseJobs, abuseMailMessages, abuseProviderRoutes, abuseProviderRuns, abuseReports } from "../schema";
import { getProviderSubmissionProvider } from "../providers";
import { recheckAfterProviderAction } from "../worker/provider_action";
import { sha256Hex } from "@/lib/util/hash";
import { reportHostMove } from "./report";
import { CASE, check, DEMO_JS, events, jobs, LETS_ENCRYPT, nextCheckAt, recordingSend, reportedAt, resolving, routeOf, site, trylevo } from "./report.fixtures";

useTemporaryDatabase();

describe("trylevo.app leaves Cloudflare after Cloudflare restricted it (case 384401854580134038)", () => {
	test("the check records the move with its proof, the host gets a follow-up, Cloudflare is told its block was bypassed, and the pages say so", async () => {
		const { reportId, targetId } = await trylevo();
		await check(targetId, site(["85.137.52.128"], trylevoAt("21:30:05")));

		const [recordedCheck] = await listSiteChecksForTargets([targetId]);
		expect(recordedCheck!.hosting).toEqual({ addresses: [{ ip: "85.137.52.128", asn: 43641, holder: "Sollutium-NL SOLLUTIUM EU Sp z.o.o.", prefix: "85.137.52.0/24" }], server: "nginx/1.30.0" });
		const [moved] = await events(reportId, HOST_MOVED_EVENT);
		expect(moved).toMatchObject({ targetId, data: {
			kind: "left_cdn",
			at: "2026-11-26T21:30:05.000Z",
			since: "2026-11-26T18:50:04.000Z",
			from: { name: "Cloudflare", cdn: "Cloudflare", asn: 13335, addresses: ["188.114.96.2", "188.114.97.2"] },
			to: { name: "Sollutium-NL", asn: 43641, addresses: ["85.137.52.128"] },
			content: "served",
			evidence: { url: "https://trylevo.app/", state: "online", httpStatus: 200, server: "nginx/1.30.0", certificate: LETS_ENCRYPT, kitFiles: [{ url: "https://trylevo.app/js/demo.js", sha256: sha256Hex(DEMO_JS) }] },
		} });
		const [action] = await jobs("report_host_move");
		expect(action).toMatchObject({ reportId, status: "queued", payload: { key: (moved!.data as { key: string }).key } });
		// The next check comes an hour after the move, not at the 6-hour offset.
		expect(await nextCheckAt(targetId)).toEqual([trylevoAt("22:30:05")]);

		const { sent, send } = recordingSend();
		const ip = resolving("abuse-ams@v-sys.org", 43641);
		await reportHostMove({ reportId, key: String(action!.payload!.key) }, { resolveIp: ip.resolveIp, send });
		expect(ip.asked).toEqual(["85.137.52.128"]);

		// No new route: V-SYS was already reported through Cloudflare's disclosure.
		expect((await AbuseRepository.listRoutes(reportId)).map((route) => route.providerRegistryKey).sort()).toEqual(["cloudflare", "namesilo", "netcraft", "origin-host-email"]);
		expect(sent.map(({ recipient, subject }) => ({ recipient, subject }))).toEqual([
			{ recipient: "abuse-ams@v-sys.org", subject: "Re: [Phishing Support] [PS-b7e34e00101c] Malware abuse: malware distribution site for trylevo.app (Cloudflare report 983629f3ca31bae5)" },
			{ recipient: "abusereply@cloudflare.com", subject: "[983629f3ca31bae5] Additional evidence for abuse report 983629f3ca31bae5" },
		]);
		const [host, cloudflare] = sent;
		expect(host!.body).toBe([
			"Hello Sollutium-NL Abuse Team,",
			"",
			"Further to our report of the malware distribution site trylevo.app: trylevo.app no longer runs behind Cloudflare's proxy: as of 26 Nov 2026 21:30 UTC it resolves directly to 85.137.52.128, in your network AS43641 (Sollutium-NL SOLLUTIUM EU Sp z.o.o.), and that server serves the reported site itself; on 26 Nov 2026 18:50 UTC it still resolved to 188.114.96.2 and 188.114.97.2, in Cloudflare (AS13335).",
			"",
			"What we found:",
			"- DNS: trylevo.app resolves to 85.137.52.128 (checked 26 Nov 2026 21:30 UTC; on 26 Nov 2026 18:50 UTC: 188.114.96.2 and 188.114.97.2, Cloudflare (AS13335)).",
			`- TLS: 85.137.52.128:443 presents a certificate for trylevo.app issued by C=US, O=Let's Encrypt, CN=R13, valid 2026-11-26 to 2027-02-24, SHA-256 fingerprint ${LETS_ENCRYPT.fingerprint256}.`,
			"- HTTP: the server answers as \"nginx/1.30.0\".",
			"- Content: this file is byte-identical to what we captured when we reported the site:",
			`  https://trylevo.app/js/demo.js (SHA-256 ${sha256Hex(DEMO_JS)})`,
			"",
			"To check it yourself:",
			"  openssl s_client -connect 85.137.52.128:443 -servername trylevo.app",
			"  curl -s --resolve 'trylevo.app:443:85.137.52.128' 'https://trylevo.app/js/demo.js' | sha256sum",
			"",
			"Please suspend the service at 85.137.52.128 and preserve its data for law enforcement.",
			"",
			"Evidence (screenshots, archived page, analysis): https://phishing.support/submissions/384401854580134038",
			"",
			"Thank you,",
			"Phishing Support",
			"support@phishing.support",
			"https://phishing.support",
		].join("\n"));
		expect(cloudflare!.body).toStartWith("Hello Cloudflare Trust & Safety,\n\nRegarding report 983629f3ca31bae5 (trylevo.app): you acted on the reported malware distribution site, and the site has since been taken off your network. trylevo.app no longer runs behind Cloudflare's proxy: as of 26 Nov 2026 21:30 UTC it resolves directly to 85.137.52.128, in AS43641 (Sollutium-NL SOLLUTIUM EU Sp z.o.o.), and that server serves the reported site itself; on 26 Nov 2026 18:50 UTC it still resolved to 188.114.96.2 and 188.114.97.2, in Cloudflare (AS13335). Whatever you applied to it no longer stands between the site and its visitors.");
		expect(cloudflare!.body).toContain("We have told the new host (abuse-ams@v-sys.org).");
		expect(cloudflare!.routeId).toBe((await routeOf(reportId, "cloudflare")).id);

		// NameSilo has not acted and names no channel for more evidence: on record, nothing invented.
		const actions = (await events(reportId, HOST_MOVE_ACTION_EVENT)).map((event) => event.data as { role: string; action: string; to?: string });
		expect(actions.map(({ role, action, to }) => ({ role, action, to }))).toEqual([
			{ role: "host", action: "followed_up", to: "abuse-ams@v-sys.org" },
			{ role: "cdn", action: "followed_up", to: "abusereply@cloudflare.com" },
			{ role: "registrar", action: "no_channel", to: undefined },
		]);

		// The job again, and the check an hour later at the same host: nothing more.
		await reportHostMove({ reportId, key: String(action!.payload!.key) }, { resolveIp: ip.resolveIp, send });
		await check(targetId, site(["85.137.52.128"], trylevoAt("22:30:05")));
		expect(sent).toHaveLength(2);
		expect(await events(reportId, HOST_MOVED_EVENT)).toHaveLength(1);
		expect(await events(reportId, HOST_MOVE_ACTION_EVENT)).toHaveLength(3);
		expect(await jobs("report_host_move")).toHaveLength(1);
		// Back on the report's schedule: the 6-hour check.
		expect(await nextCheckAt(targetId)).toEqual([new Date(trylevoAt("00:50:04").getTime() + 24 * 3_600_000)]);

		// The case page: the takedown status is the move, and Cloudflare's restriction reads as bypassed.
		const [siteReport] = await getReportsForSubmission(CASE);
		const summary = takedownSummary([siteReport!], String(CASE));
		expect(summary.moved?.text).toBe("Moved to Sollutium-NL (AS43641) at 26 Nov 21:30 UTC — still serving malware");
		expect(summary.counts.action_taken).toBe(0);
		expect(summary.counts.bypassed).toBe(1);
		const entry = rankedRoutes([siteReport!]).find(({ route }) => route.organisation === "Cloudflare")!;
		expect(entry.standing).toMatchObject({ bucket: "bypassed", label: "Block bypassed", line: "Moved to Sollutium-NL (AS43641) at 26 Nov 21:30 UTC — still serving malware", at: trylevoAt("21:30:05") });
		expect(nextStep(entry.route, entry.standing, siteReport!.createdAt)).toMatch(/^We told Cloudflare at .+ UTC that its block was bypassed\.$/);
		const hostEntry = rankedRoutes([siteReport!]).find(({ route }) => route.organisation === "Sollutium-NL")!;
		expect(nextStep(hostEntry.route, hostEntry.standing, siteReport!.createdAt)).toMatch(/^We told Sollutium-NL at .+ UTC that the site moved; its reply is read automatically\.$/);
		const notice = entry.route.messages.find((message) => message.moveNotice)!;
		expect(notice).toMatchObject({ direction: "outbound", moveNotice: true, decisionReply: false });
	});

	test("a later check that finds the site down settles the move on the case page", async () => {
		const { reportId, targetId } = await trylevo();
		await check(targetId, site(["85.137.52.128"], trylevoAt("21:30:05")));
		const down = site(["85.137.52.128"], trylevoAt("22:30:05"));
		await check(targetId, { ...down, fetch: async () => new Response("<html><title>Suspended</title>This account has been suspended.</html>", { status: 451, headers: { "content-type": "text/html" } }) });
		const [siteReport] = await getReportsForSubmission(CASE);
		expect(siteReport!.latestCheck?.state).toBe("host_suspended");
		expect(takedownSummary([siteReport!]).moved).toBeUndefined();
		expect(await events(reportId, HOST_MOVED_EVENT)).toHaveLength(1);
	});

	test("a provider that was already written to since the site moved is not written to again", async () => {
		const { reportId, targetId } = await trylevo();
		const cloudflare = await routeOf(reportId, "cloudflare");
		const [run] = await AbuseRepository.listProviderRunsForReport(reportId).then((runs) => runs.filter((candidate) => candidate.routeId === cloudflare.id));
		// The operator's own follow-up of 26 Nov (scripts/route_follow_up.ts).
		const rawArtifactId = await AbuseRepository.saveArtifact({ reportId, routeId: cloudflare.id, runId: run!.id, name: "operator.eml", kind: "outbound_mail_mime", mimeType: "message/rfc822", buffer: Buffer.from(TRYLEVO_MAIL.cloudflareFollowUp) });
		await AbuseRepository.createOutboundMail({ reportId, routeId: cloudflare.id, runId: run!.id, fromAddress: "support@phishing.support", toAddresses: ["abusereply@cloudflare.com"], subject: "[983629f3ca31bae5] trylevo.app left Cloudflare", textBody: TRYLEVO_MAIL.cloudflareFollowUp, messageId: "<op@phishing.support>", replyAddress: "abuse-op@reply.phishing.support", correlationKey: `follow-up:${cloudflare.id}:2026-11-26T21:10:00.000Z`, rawArtifactId, attachmentArtifactIds: [] });
		(await getDb()).update(abuseMailMessages).set({ occurredAt: trylevoAt("21:10:00"), status: "sent" }).where(eq(abuseMailMessages.messageId, "<op@phishing.support>")).run();

		await check(targetId, site(["85.137.52.128"], trylevoAt("21:30:05")));
		const [action] = await jobs("report_host_move");
		const { sent, send } = recordingSend();
		await reportHostMove({ reportId, key: String(action!.payload!.key) }, { resolveIp: resolving("abuse-ams@v-sys.org", 43641).resolveIp, send });
		expect(sent.map(({ recipient }) => recipient)).toEqual(["abuse-ams@v-sys.org"]);
		expect((await events(reportId, HOST_MOVE_ACTION_EVENT)).filter((event) => event.routeId === cloudflare.id).map((event) => (event.data as { action: string }).action)).toEqual(["already_told"]);
	});

	test("Cloudflare's restriction brings the next check forward to within the hour; an action a check already saw changes nothing", async () => {
		const { reportId, targetId } = await trylevo();
		const cloudflare = await routeOf(reportId, "cloudflare");
		const db = await getDb();
		// Reported two hours ago and checked a minute ago: the next check on the schedule is four hours away.
		const now = Date.now();
		db.update(abuseReports).set({ createdAt: new Date(now - 2 * 3_600_000) }).where(eq(abuseReports.id, reportId)).run();
		await recordSiteCheck({ reportId, targetId }, { url: "https://trylevo.app/", state: "online", resolvedAddresses: ["188.114.96.2"], domainStatuses: [], checkedAt: new Date(now - 60_000) });
		db.update(abuseJobs).set({ nextAttemptAt: new Date(now + 4 * 3_600_000) }).where(eq(abuseJobs.dedupeKey, livenessJobKey(targetId))).run();
		const restricted = { direction: "inbound" as const, correlationKey: "provider-api:cloudflare:2f28c335", subject: "[983629f3ca31bae5]: Response to your Phishing report", textBody: TRYLEVO_MAIL.cloudflareRestricted, occurredAt: new Date(now - 50 * 60_000) };

		// A receipt is no action.
		await recheckAfterProviderAction(cloudflare, [{ ...restricted, textBody: TRYLEVO_MAIL.cloudflareConfirmation }]);
		expect(await nextCheckAt(targetId)).toEqual([new Date(now + 4 * 3_600_000)]);
		await recheckAfterProviderAction(cloudflare, [restricted]);
		expect(await nextCheckAt(targetId)).toEqual([new Date(now + 10 * 60_000)]);
		// An action before the last check's hour: that check saw what it did.
		await checkSoonAfter(targetId, new Date(now - 3 * 3_600_000));
		expect(await nextCheckAt(targetId)).toEqual([new Date(now + 10 * 60_000)]);
	});

	test("the site's origin address, reported as a target of its own, is never judged to move", async () => {
		const { reportId } = await trylevo();
		const origin = await AbuseRepository.upsertDerivedTarget({ reportId, normalizedTarget: "85.137.52.128", targetType: "ip", observedUrls: ["https://trylevo.app/"], resolverSnapshot: TRYLEVO_ROUTED_SNAPSHOT, disposition: "cloudflare_origin_host" });
		await scheduleLivenessChecks(origin.id);
		await check(origin.id, site(["85.137.52.128"], trylevoAt("21:30:05")));
		expect(await events(reportId, HOST_MOVED_EVENT)).toEqual([]);
		expect(await jobs("report_host_move")).toEqual([]);
	});
});

describe("other moves", () => {
	test("host A to host B: the new host's abuse contact becomes a new route of the same report, with the move as evidence", async () => {
		const { reportId, targetId, domain } = await reportedAt("5.161.1.1", 213230, "Hetzner Online GmbH");
		await check(targetId, site(["85.137.52.128"], new Date("2026-11-27T08:00:00Z"), { domain }));
		const [moved] = await events(reportId, HOST_MOVED_EVENT);
		expect(moved!.data).toMatchObject({ kind: "new_network", from: { name: "Hetzner Online GmbH", asn: 213230 }, to: { name: "Sollutium-NL", asn: 43641 }, content: "served" });

		const { sent, send } = recordingSend();
		const [action] = await jobs("report_host_move");
		await reportHostMove({ reportId, key: String(action!.payload!.key) }, { resolveIp: resolving("abuse-ams@v-sys.org", 43641).resolveIp, send });
		expect(sent).toEqual([]);
		const [route] = await AbuseRepository.listRoutes(reportId);
		expect(route).toMatchObject({ targetId, routeKey: "email:abuse-ams@v-sys.org", routeType: "email", verifiedEmail: "abuse-ams@v-sys.org", status: "verified", resolverProvenance: { source: "domain_infrastructure_ip", originatingDomain: domain, originatingIp: "85.137.52.128" } });
		const [evidence] = await AbuseRepository.listRouteArtifacts(route!.id, ["host_move_evidence"]);
		expect(evidence!.blob.toString()).toStartWith(`Hosting change of ${domain}\nObserved: 2026-11-27T08:00:00.000Z\nFrom: 5.161.1.1, AS213230 (Hetzner Online GmbH)\nTo: 85.137.52.128, AS43641 (Sollutium-NL SOLLUTIUM EU Sp z.o.o.)`);
		expect((await jobs("send_email")).map((candidate) => ({ routeId: candidate.routeId, dedupeKey: candidate.dedupeKey }))).toEqual([{ routeId: route!.id, dedupeKey: `email:${route!.id}` }]);
		expect((await events(reportId, HOST_MOVE_ACTION_EVENT)).map((event) => event.data)).toEqual([{ key: action!.payload!.key, role: "host", action: "reported", to: "abuse-ams@v-sys.org" }]);

		// A retried job finds the route, its evidence and its delivery as they are.
		await reportHostMove({ reportId, key: String(action!.payload!.key) }, { resolveIp: resolving("abuse-ams@v-sys.org", 43641).resolveIp, send });
		expect(await AbuseRepository.listRoutes(reportId)).toHaveLength(1);
		expect(await jobs("send_email")).toHaveLength(1);
		expect(await events(reportId, HOST_MOVE_ACTION_EVENT)).toHaveLength(1);
	});

	test("a registrar that has not acted: its correspondence is read again, and the move goes through the form it takes more evidence by", async () => {
		const { reportId, targetId, domain } = await reportedAt("5.161.1.1", 213230, "Hetzner Online GmbH");
		const db = await getDb();
		const routeId = 384500000000000001n;
		db.insert(abuseProviderRoutes).values({ id: routeId, reportId, targetId, routeKey: "provider_submission:eranet:registrar", providerRegistryKey: "eranet", providerDisplayName: "Eranet Fraud & Phishing Report", routeType: "provider_submission", resolverProvenance: { source: "domain_rdap" }, resolutionSnapshot: {}, status: "submitted" }).run();
		db.insert(abuseProviderRuns).values({ id: 384500000000000002n, reportId, routeId, providerPayload: { adapter: "eranet" }, payloadHash: "x", correlationKey: "run:eranet", executionStatus: "completed", confirmationId: "e8a998e9-ed1c-449c-a426-de1c6c183154" }).run();
		const screenshot = Buffer.from("\x89PNG lure page");
		db.insert(abuseArtifacts).values({ id: 384500000000000003n, reportId, name: "website.png", kind: "user_evidence_original", mimeType: "image/png", sha256: sha256Hex(screenshot), size: screenshot.length, blob: screenshot }).run();

		await check(targetId, site(["85.137.52.128"], new Date("2026-11-27T08:00:00Z"), { domain }));
		const filed: Array<{ confirmationId: string; body: string; attachments: string[] }> = [];
		const eranet = getProviderSubmissionProvider("eranet")!;
		const providerFor = ((key: string) => key !== "eranet" ? getProviderSubmissionProvider(key) : {
			...eranet,
			fetchCorrespondence: async () => ({ messages: [], final: false }),
			decisionFollowUp: { ...eranet.decisionFollowUp!, channel: { ...eranet.decisionFollowUp!.channel as Extract<NonNullable<typeof eranet.decisionFollowUp>["channel"], { kind: "form" }>, submit: async (answer, markSending) => {
				await markSending();
				filed.push({ confirmationId: answer.confirmationId, body: answer.body, attachments: answer.attachments.map((file) => file.filename) });
			} } },
		}) as typeof getProviderSubmissionProvider;
		const [action] = await jobs("report_host_move");
		await reportHostMove({ reportId, key: String(action!.payload!.key) }, { resolveIp: resolving("abuse-ams@v-sys.org", 43641).resolveIp, send: recordingSend().send, providerFor });
		await reportHostMove({ reportId, key: String(action!.payload!.key) }, { resolveIp: resolving("abuse-ams@v-sys.org", 43641).resolveIp, send: recordingSend().send, providerFor });

		expect(filed).toHaveLength(1);
		expect(filed[0]!.confirmationId).toBe("e8a998e9-ed1c-449c-a426-de1c6c183154");
		expect(filed[0]!.attachments).toEqual(["website.png"]);
		expect(filed[0]!.body).toStartWith(`Hello Eranet Trust & Safety,\n\nFurther to our report of the malware distribution site ${domain}: the domain is still in use. ${domain} has moved: as of 27 Nov 2026 08:00 UTC it resolves to 85.137.52.128, in AS43641 (Sollutium-NL SOLLUTIUM EU Sp z.o.o.), and that server serves the reported site; on `);
		expect(filed[0]!.body).toContain("it still resolved to 5.161.1.1, in AS213230 (Hetzner Online GmbH).");
		expect(filed[0]!.body).toContain(`Please suspend the domain ${domain}.`);
		expect((await jobs("poll_provider_correspondence")).map((job) => job.routeId)).toEqual([routeId]);
		expect((await events(reportId, HOST_MOVE_ACTION_EVENT)).filter((event) => event.routeId === routeId).map((event) => (event.data as { action: string }).action)).toEqual(["rechecked", "followed_up"]);
	});

	test("behind another CDN: the CDN's abuse contact is reported", async () => {
		const { reportId, targetId, domain } = await reportedAt("5.161.1.1", 213230, "Hetzner Online GmbH");
		await check(targetId, site(["151.101.1.195"], new Date("2026-11-27T08:00:00Z"), { domain, server: "Varnish" }));
		const [moved] = await events(reportId, HOST_MOVED_EVENT);
		expect(moved!.data).toMatchObject({ kind: "new_cdn", to: { name: "Fastly", cdn: "Fastly", asn: 54113 }, content: "served", evidence: { server: "Varnish" } });
		expect((moved!.data as { evidence: Record<string, unknown> }).evidence.certificate).toBeUndefined();
		const [action] = await jobs("report_host_move");
		await reportHostMove({ reportId, key: String(action!.payload!.key) }, { resolveIp: resolving("abuse@fastly.com", 54113).resolveIp, send: recordingSend().send });
		expect((await AbuseRepository.listRoutes(reportId)).map((route) => route.verifiedEmail)).toEqual(["abuse@fastly.com"]);
	});

	test("new addresses in the same network are no move: nothing recorded, no action, the normal schedule", async () => {
		const { reportId, targetId } = await trylevo();
		await check(targetId, site(["188.114.96.3", "104.21.32.1"], trylevoAt("19:50:04")));
		expect(await events(reportId, HOST_MOVED_EVENT)).toEqual([]);
		expect(await jobs("report_host_move")).toEqual([]);
		expect(await nextCheckAt(targetId)).toEqual([new Date(trylevoAt("00:50:04").getTime() + 24 * 3_600_000)]);
	});

	test("a move whose content is gone is recorded without a report, and acted on once the content is back", async () => {
		const { reportId, targetId } = await trylevo();
		await check(targetId, site(["85.137.52.128"], trylevoAt("21:30:05"), { script: 404 }));
		expect((await events(reportId, HOST_MOVED_EVENT)).map((event) => (event.data as { content: string }).content)).toEqual(["gone"]);
		expect(await jobs("report_host_move")).toEqual([]);
		const [siteReport] = await getReportsForSubmission(CASE);
		expect(takedownSummary([siteReport!]).moved).toBeUndefined();
		expect(rankedRoutes([siteReport!]).find(({ route }) => route.organisation === "Cloudflare")!.standing.bucket).toBe("action_taken");

		// Still gone at the next check: nothing new on record.
		await check(targetId, site(["85.137.52.128"], trylevoAt("22:30:05"), { script: 404 }));
		expect(await events(reportId, HOST_MOVED_EVENT)).toHaveLength(1);

		// Served again: the same move, confirmed, and acted on once.
		await check(targetId, site(["85.137.52.128"], trylevoAt("23:50:00")));
		const recorded = await events(reportId, HOST_MOVED_EVENT);
		expect(recorded.map((event) => (event.data as { content: string }).content)).toEqual(["gone", "served"]);
		expect(new Set(recorded.map((event) => (event.data as { key: string }).key)).size).toBe(1);
		expect(hostMovesOf(recorded)).toHaveLength(1);
		expect(await jobs("report_host_move")).toHaveLength(1);
	});
});

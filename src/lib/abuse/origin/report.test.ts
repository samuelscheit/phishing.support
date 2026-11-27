import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { ArtifactsEntity } from "../../db/entities/artifacts";
import { SubmissionsEntity } from "../../db/entities/submissions";
import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { createAbuseEmailDraft } from "../mail/draft";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { abuseArtifacts, jobs } from "../schema";
import { readOriginHostSnapshot, type KitCollectedData } from "./snapshot";
import { reportOriginHost, type OriginHostReportDependencies } from "./report";
import { sha256Hex } from "../../util/hash";
import type { PassiveDnsHistory, PassiveDnsRecord } from "../../network/passive_dns";

const CLOUDFLARE_RESPONSE = `Hello,

We have also forwarded this report to the relevant hosting provider.
The host for the reported domain is:
abuse@host.example
You may use this information to follow up directly with the hosting provider.`;

const noHistory = async (domain: string): Promise<PassiveDnsHistory> => ({ hosts: [domain], sources: ["virustotal"], records: [], errors: [] });

function historyOf(records: Array<Partial<PassiveDnsRecord> & Pick<PassiveDnsRecord, "host" | "ip" | "lastSeen">>, errors: string[] = []) {
	const calls: string[] = [];
	const passiveDns = async (domain: string): Promise<PassiveDnsHistory> => {
		calls.push(domain);
		return { hosts: [domain], sources: ["virustotal"], records: records.map((record) => ({ type: record.ip.includes(":") ? "AAAA" : "A", sources: ["virustotal"], ...record })), errors };
	};
	return { calls, passiveDns };
}

/** A report on `domain` whose Cloudflare route received the reply naming `mailbox` as host. */
async function cloudflareDisclosure(domain: string, mailbox: string, sentAt: Date) {
	const request = await validateAbuseReportRequest({
		targets: [domain],
		allegationCategory: "phishing",
		description: "Captured page requests account credentials.",
		observedUrls: [{ target: domain, urls: [`https://${domain}/gg/fkd`] }],
		legalBrandUrl: "https://www.google.com/",
	});
	const created = await AbuseRepository.createReport({ request, reporter: {} });
	const [sourceTarget] = await AbuseRepository.listTargets(created.reportId);
	const cloudflareRoute = await AbuseRepository.upsertResolvedRoute(sourceTarget!.id, { routeKey: "provider:cloudflare", providerRegistryKey: "cloudflare", providerDisplayName: "Cloudflare Abuse", routeType: "provider_submission", resolverProvenance: {}, resolutionSnapshot: {}, status: "verified" });
	const [stored] = await AbuseRepository.recordProviderCorrespondence({
		route: cloudflareRoute,
		messages: [{ id: `cf-${domain}`, subject: "[0123456789abcdef]: Response to your Phishing report", body: CLOUDFLARE_RESPONSE.replace("abuse@host.example", mailbox), sentAt, from: "Cloudflare" }],
	});
	const originRoute = async () => (await AbuseRepository.listRoutes(created.reportId)).find(({ routeKey }) => routeKey === `origin-host:${mailbox}`);
	return { reportId: created.reportId, messageId: stored!.id, sourceTarget: sourceTarget!, originRoute };
}

const quietCase = {
	kitFacts: async () => ({ collects: [], exfiltrationProbed: false, exfiltrationTargets: [] }),
	registeredAt: async () => undefined,
} satisfies OriginHostReportDependencies;

/** The DigitalOcean form's report as its draft prepares it for the route. */
async function digitalOceanReport(routeId: bigint): Promise<Record<string, string | null>> {
	const { digitalOceanDraft } = await import("../providers/digitalocean/submission");
	const prepared = await digitalOceanDraft.prepare({ routeId, payload: {} });
	if (prepared.outcome !== "ready") throw new Error(`DigitalOcean draft not ready: ${prepared.reason}`);
	return (prepared.payload as { report: Record<string, string | null> }).report;
}

const network = (asn: number, holder: string, prefixes: string[]) => async () => ({
	recipient: "",
	mailboxDomain: "",
	networks: [{ asn, holder, prefixes, discoverySources: ["registry_name_search"] }],
	errors: [],
});

describe("origin-host report workflow", () => {
	useTemporaryDatabase();

	test("creates the origin target, evidence, email route, and sibling case idempotently", async () => {
		const submissionId = 410000000000000001n;
		await SubmissionsEntity.create({
			id: submissionId,
			kind: "website",
			data: { kind: "website", website: { url: "https://login.example.com/", routes: [{ hops: [], siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft" }] }] } },
			dedupeKey: "website-login.example.com",
			status: "reported",
			source: "https://login.example.com/",
		});
		const capturedCss = Buffer.from(".captured-kit { color: red; }\n".repeat(40));
		const capturedCssSha256 = sha256Hex(capturedCss);
		await ArtifactsEntity.saveBuffer({
			submissionId,
			name: "website.mhtml",
			kind: "website_mhtml",
			mimeType: "text/mhtml",
			buffer: Buffer.from([
				"MIME-Version: 1.0",
				"Content-Type: multipart/related; boundary=kit",
				"",
				"--kit",
				"Content-Type: text/css",
				"Content-Transfer-Encoding: base64",
				"Content-Location: https://login.example.com/kit.css?v=1",
				"",
				capturedCss.toString("base64"),
				"--kit--",
			].join("\r\n")),
		});
		const request = await validateAbuseReportRequest({
			targets: ["login.example.com"],
			allegationCategory: "phishing",
			description: "Captured page requests account credentials.",
			observedUrls: [{ target: "login.example.com", urls: ["https://login.example.com/signin"] }],
		});
		const reportResult = await AbuseRepository.createReport({ request, reporter: { reporterCountry: "DE" }, submissionId });
		const report = (await AbuseRepository.getReport(reportResult.reportId))!;
		const [sourceTarget] = await AbuseRepository.listTargets(report.id);
		const cloudflareRoute = await AbuseRepository.upsertResolvedRoute(sourceTarget!.id, {
			routeKey: "provider:cloudflare",
			providerRegistryKey: "cloudflare",
			providerDisplayName: "Cloudflare Abuse",
			routeType: "provider_submission",
			resolverProvenance: {},
			resolutionSnapshot: {},
			status: "verified",
		});
		const [stored] = await AbuseRepository.recordProviderCorrespondence({
			route: cloudflareRoute,
			messages: [{
				id: "cloudflare-host-message",
				subject: "[0123456789abcdef]: Response to your Phishing report",
				body: CLOUDFLARE_RESPONSE,
				sentAt: new Date("2026-10-30T22:00:00.000Z"),
				from: "Cloudflare",
			}],
		});
		const siblingOptions: Array<{ url: string; source?: string }> = [];
		const sweptSlices: string[][] = [];
		const verificationTargets: Array<Array<{ path: string; sha256: string }>> = [];
		const originCertificate = { names: ["login.example.com"], notBefore: "2026-10-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z", issuer: "C=US, O=Let's Encrypt, CN=R11", fingerprint256: "AA:BB" };
		const siblingCertificate = { ...originCertificate, names: ["sibling.example.net"], notBefore: "2026-10-20T10:00:00.000Z", fingerprint256: "CC:DD" };
		let networkResolutions = 0;
		const dependencies = {
			resolveNetworks: async () => {
				networkResolutions++;
				return {
					recipient: "abuse@host.example",
					mailboxDomain: "host.example",
					networks: [{ asn: 64500, holder: "Example Hosting GmbH", prefixes: ["8.8.8.0/29"], discoverySources: ["registry_name_search"] }],
					errors: [],
				};
			},
			findServers: async ({ addresses, verificationTargets: targets }: { addresses: readonly string[]; verificationTargets: readonly { path: string; sha256: string }[] }) => {
				sweptSlices.push([...addresses]);
				verificationTargets.push([...targets]);
				return addresses.includes("8.8.8.6") ? [{ ip: "8.8.8.6", certificate: originCertificate }] : [];
			},
			discoverSiblings: async () => ({
				fingerprints: [{ sha256: "a".repeat(64), kind: "stylesheet" as const, url: "https://login.example.com/kit.css", size: 2048 }],
				candidateCount: 2,
				confirmed: [{ domain: "sibling.example.net", url: "https://sibling.example.net/login", matchingHashes: ["a".repeat(64)], originIp: "8.8.8.6", certificate: siblingCertificate }],
				errors: [],
			}),
			createSiblingSubmission: async (options: { url: string; source?: string }) => {
				siblingOptions.push(options);
				return { id: 410000000000000002n, status: "queued" as const };
			},
			kitFacts: async () => ({
				abuse: "credential_theft" as const,
				evidenceQuote: "Sign in with your Example Account",
				collects: ["sign-in email or phone", "password", "one-time 2FA codes"] satisfies KitCollectedData[],
				exfiltrationProbed: true,
				exfiltrationTargets: ["telegram-bot:123456"],
			}),
			registeredAt: async (domain: string) => domain === "sibling.example.net" ? "2026-10-19T08:00:00.000Z" : "2026-09-30T12:00:00.000Z",
			passiveDns: noHistory,
			sliceAddresses: 3,
		};

		// Slice 1 sweeps 8.8.8.0-2 and hands its progress to a successor job.
		const queuedJob = async () => (await (await getDb()).select().from(jobs).where(and(eq(jobs.jobType, "report_origin_host"), eq(jobs.status, "queued"))).all());
		await reportOriginHost({ reportId: report.id, messageId: stored!.id }, dependencies);
		expect(sweptSlices).toEqual([["8.8.8.0", "8.8.8.1", "8.8.8.2"]]);
		expect(verificationTargets).toEqual([[{ path: "/kit.css?v=1", sha256: capturedCssSha256 }]]);
		expect(await AbuseRepository.listRoutes(report.id)).toHaveLength(1);
		const [successor] = await queuedJob();
		expect(successor!.payload).toMatchObject({ messageId: stored!.id.toString(), progress: { offset: 3, servers: [] } });

		// A replayed successor must not double-queue; the chain continues from its own payload.
		await reportOriginHost({ reportId: report.id, messageId: stored!.id, progress: (successor!.payload as { progress: never }).progress, jobId: successor!.id }, dependencies);
		expect(sweptSlices.at(-1)).toEqual(["8.8.8.3", "8.8.8.4", "8.8.8.5"]);
		const [third] = (await queuedJob()).filter(({ id }) => id !== successor!.id);
		expect(third!.payload).toMatchObject({ progress: { offset: 6 } });
		await reportOriginHost({ reportId: report.id, messageId: stored!.id, progress: (third!.payload as { progress: never }).progress, jobId: third!.id }, dependencies);
		expect(sweptSlices.at(-1)).toEqual(["8.8.8.6", "8.8.8.7"]);
		expect(networkResolutions).toBe(1);
		expect(siblingOptions).toMatchObject([{
			url: "https://sibling.example.net/login",
			source: `origin-sibling:${submissionId.toString()}:${stored!.id.toString()}`,
		}]);
		const targets = await AbuseRepository.listTargets(report.id);
		const originTarget = targets.find(({ normalizedTarget }) => normalizedTarget === "8.8.8.6")!;
		expect(originTarget).toMatchObject({
			targetType: "ip",
			observedUrls: ["https://login.example.com/signin", "https://sibling.example.net/login"],
			resolutionStatus: "resolved",
			disposition: "cloudflare_origin_host",
		});
		const routes = await AbuseRepository.listRoutes(report.id);
		const originRoute = routes.find(({ routeKey }) => routeKey === "origin-host:abuse@host.example")!;
		expect(originRoute).toMatchObject({ routeType: "email", verifiedEmail: "abuse@host.example", status: "verified" });
		const snapshot = readOriginHostSnapshot(originRoute.resolutionSnapshot)!;
		expect(snapshot.servers[0]).toMatchObject({ ip: "8.8.8.6", asn: 64500, prefix: "8.8.8.0/29", discovery: "tls_sweep" });
		expect(snapshot.scan).toMatchObject({ addressesScanned: 8, totalAddresses: 8, truncated: false, selectedPrefixes: [{ asn: 64500, prefix: "8.8.8.0/29" }] });
		expect(snapshot.dnsHistory).toEqual({ hosts: ["login.example.com"], sources: ["virustotal"], recordsFound: 0 });
		expect(snapshot.historicalResolutions).toEqual([]);
		expect(snapshot.siblings[0]).toMatchObject({ domain: "sibling.example.net", submissionId: "410000000000000002", registeredAt: "2026-10-19T08:00:00.000Z" });
		expect(snapshot.originalDomainRegisteredAt).toBe("2026-09-30T12:00:00.000Z");
		const artifacts = await AbuseRepository.listRouteArtifacts(originRoute.id, ["origin_host_evidence"]);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]!.blob.toString()).toContain("8.8.8.6 AS64500");
		expect(artifacts[0]!.blob.toString()).toContain("openssl s_client -connect 8.8.8.6:443 -servername login.example.com");
		const draft = await createAbuseEmailDraft({
			report,
			target: originTarget,
			route: originRoute,
			recipient: "abuse@host.example",
			attachmentNames: ["website.png", "origin-host-evidence.txt"],
			attachmentMimeTypes: ["image/png", "text/plain"],
		});
		expect(draft.subject).toBe(`[Phishing Support] [${draft.subject.match(/PS-[0-9a-f]+/)![0]}] Phishing abuse: credential phishing kit on 8.8.8.6 (Cloudflare report 0123456789abcdef)`);
		expect(draft.body).toBe(`Hello Example Hosting GmbH Abuse Team,

A server in your network runs a phishing operation that steals account credentials, including one-time 2FA codes. Please suspend it and preserve its data for law enforcement.

Server: 8.8.8.6 (8.8.8.0/29, AS64500)

Phishing domains served from it:
- login.example.com (behind Cloudflare)
- sibling.example.net

How the server is tied to these domains (observed ${draft.body.match(/observed (\d{4}-\d\d-\d\d \d\d:\d\d UTC)/)![1]}): a request pinned to 8.8.8.6:443 returned a byte-identical captured phishing-kit file (same SHA-256), and the TLS endpoint presents a certificate for each domain from Let's Encrypt:
- login.example.com: issued 2026-10-01 00:00 UTC, domain registered 2026-09-30 12:00 UTC
  SHA-256 AA:BB
- sibling.example.net: issued 2026-10-20 10:00 UTC, domain registered 2026-10-19 08:00 UTC
  SHA-256 CC:DD
You can check this with: openssl s_client -connect 8.8.8.6:443 -servername login.example.com
We found it by checking 8 public IPv4 addresses announced by AS64500 for both the certificate and captured kit bytes.

What the kit does: it asks victims for their sign-in email or phone, password and one-time 2FA codes. The page reads: "Sign in with your Example Account"
In a controlled test with synthetic data, the kit sent what was typed to: telegram-bot:123456.
The server therefore holds live victim credentials.

login.example.com is behind Cloudflare. Cloudflare processed our phishing report (report 0123456789abcdef) and named abuse@host.example as the host. The other domain serves byte-identical kit files (same SHA-256 on urlscan.io).

Evidence (screenshot, archived page, analysis): https://phishing.support/submissions/${submissionId.toString()}
Attached: a screenshot of the phishing page (website.png) and the full content-hash, certificate and network checks (origin-host-evidence.txt).

We ask you to:
1. Suspend the server, so both domains go offline at once.
2. Preserve the disk, logs, and customer and payment records for law enforcement; the stored data identifies victims who need to be warned.
3. Check the same customer's other services for the same kit.
4. Confirm receipt and tell us what action you took.

Thank you,
Phishing Support
support@phishing.support
https://phishing.support`);

		const sendJobs = await (await getDb()).select().from(jobs).where(and(eq(jobs.jobType, "send_email"), eq(jobs.routeId, originRoute.id))).all();
		expect(sendJobs).toHaveLength(1);
		await reportOriginHost({ reportId: report.id, messageId: stored!.id }, {
			resolveNetworks: async () => { throw new Error("must not rescan"); },
			findServers: async () => { throw new Error("must not rescan"); },
			discoverSiblings: async () => { throw new Error("must not rediscover"); },
			createSiblingSubmission: async () => { throw new Error("must not recreate"); },
		});
		expect((await AbuseRepository.listTargets(report.id)).filter(({ normalizedTarget }) => normalizedTarget === "8.8.8.6")).toHaveLength(1);
		expect((await AbuseRepository.listRoutes(report.id)).filter(({ routeKey }) => routeKey === "origin-host:abuse@host.example")).toHaveLength(1);
		expect(await AbuseRepository.listRouteArtifacts(originRoute.id, ["origin_host_evidence"])).toHaveLength(1);
		expect(await (await getDb()).select().from(jobs).where(and(eq(jobs.jobType, "send_email"), eq(jobs.routeId, originRoute.id))).all()).toHaveLength(1);
		expect(await (await getDb()).select().from(abuseArtifacts).where(eq(abuseArtifacts.routeId, originRoute.id)).all()).toHaveLength(1);
	});

	test("a host whose mailbox a reviewed provider owns is reported through its form, without a made-up address", async () => {
		const disclosure = await cloudflareDisclosure("trk.example.run", "abuse@digitalocean.com", new Date("2026-11-22T06:19:36.000Z"));
		// Only Cloudflare's own addresses in the history, and an in-network one last seen long before: no address to give.
		const history = historyOf([
			{ host: "trk.example.run", ip: "104.21.46.90", lastSeen: "2026-11-21T00:00:00.000Z" },
			{ host: "trk.example.run", ip: "8.8.8.1", lastSeen: "2026-11-07T06:19:35.000Z" },
		]);
		await reportOriginHost({ reportId: disclosure.reportId, messageId: disclosure.messageId }, {
			...quietCase,
			resolveNetworks: network(14061, "DIGITALOCEAN-ASN", ["8.8.8.0/30"]),
			findServers: async () => [],
			passiveDns: history.passiveDns,
		});
		const route = (await disclosure.originRoute())!;
		expect(route).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "digitalocean", verifiedEmail: "abuse@digitalocean.com", targetId: disclosure.sourceTarget.id, status: "verified" });
		const snapshot = readOriginHostSnapshot(route.resolutionSnapshot)!;
		expect(snapshot.servers).toEqual([]);
		expect(snapshot.historicalResolutions.map(({ ip }) => ip)).toEqual(["8.8.8.1"]);
		const queuedJobs = await (await getDb()).select().from(jobs).where(eq(jobs.routeId, route.id)).all();
		expect(queuedJobs.map(({ jobType }) => jobType)).toEqual(["submit_provider"]);

		const report = await digitalOceanReport(route.id);
		expect(report).toMatchObject({ sourceIp: null, campaignTarget: "google.com", evidenceUrl: "https://trk.example.run/gg/fkd" });
		expect(report.details).toContain("Hosting: trk.example.run is behind Cloudflare, and Cloudflare named abuse@digitalocean.com as its host (Cloudflare report 0123456789abcdef).");
		expect(report.details).not.toContain("public IPv4 addresses");
		expect(report.details).not.toContain("8.8.8.1");
	});

	test("checks the in-network DNS history first and, when it proves the origin, reports at once without a sweep", async () => {
		const disclosure = await cloudflareDisclosure("login.kit-host.com", "abuse@host.example", new Date("2026-11-22T06:19:36.000Z"));
		const history = historyOf([
			{ host: "login.kit-host.com", ip: "104.21.46.90", lastSeen: "2026-11-21T00:00:00.000Z" },
			{ host: "login.kit-host.com", ip: "8.8.8.6", lastSeen: "2026-11-20T00:00:00.000Z" },
			{ host: "kit-host.com", ip: "2a03:b0c0:2:d0::5", firstSeen: "2026-11-01T00:00:00.000Z", lastSeen: "2026-11-10T00:00:00.000Z" },
			{ host: "www.kit-host.com", ip: "9.9.9.9", lastSeen: "2026-11-09T00:00:00.000Z" },
		]);
		const certificate = { names: ["login.kit-host.com"], notBefore: "2026-11-01T00:00:00.000Z", notAfter: "2027-01-30T00:00:00.000Z", issuer: "C=US, O=Let's Encrypt, CN=R11", fingerprint256: "AA:BB" };
		const checked: string[][] = [];
		await reportOriginHost({ reportId: disclosure.reportId, messageId: disclosure.messageId }, {
			...quietCase,
			resolveNetworks: network(64500, "EXAMPLE-AS - Example Hosting GmbH, DE", ["8.8.8.0/24", "8.8.8.0/29", "2a03:b0c0::/32"]),
			findServers: async ({ addresses }) => {
				checked.push([...addresses]);
				return addresses.includes("8.8.8.6") ? [{ ip: "8.8.8.6", certificate }] : [];
			},
			passiveDns: history.passiveDns,
		});
		expect(history.calls).toEqual(["login.kit-host.com"]);
		// Only addresses inside the host's networks are checked; Cloudflare's and a stranger's are not this host's.
		expect(checked).toEqual([["8.8.8.6", "2a03:b0c0:2:d0::5"]]);
		expect(await (await getDb()).select().from(jobs).where(eq(jobs.jobType, "report_origin_host")).all()).toEqual([]);
		const route = (await disclosure.originRoute())!;
		const snapshot = readOriginHostSnapshot(route.resolutionSnapshot)!;
		expect(snapshot.servers).toEqual([{ ip: "8.8.8.6", asn: 64500, prefix: "8.8.8.0/29", certificate, discovery: "dns_history" }]);
		expect(snapshot.scan).toMatchObject({ addressesScanned: 0, totalAddresses: 256, selectedPrefixes: [] });
		expect(snapshot.dnsHistory).toEqual({ hosts: ["login.kit-host.com"], sources: ["virustotal"], recordsFound: 4 });
		expect(snapshot.historicalResolutions).toEqual([
			{ host: "kit-host.com", ip: "2a03:b0c0:2:d0::5", firstSeen: "2026-11-01T00:00:00.000Z", lastSeen: "2026-11-10T00:00:00.000Z", sources: ["virustotal"], asn: 64500, prefix: "2a03:b0c0::/32" },
		]);
		const targets = await AbuseRepository.listTargets(disclosure.reportId);
		expect(targets.find(({ id }) => id === route.targetId)).toMatchObject({ normalizedTarget: "8.8.8.6", targetType: "ip" });
		const [evidence] = await AbuseRepository.listRouteArtifacts(route.id, ["origin_host_evidence"]);
		const text = evidence!.blob.toString();
		expect(text).toContain("DNS history (passive DNS: VirusTotal) of login.kit-host.com: 4 public addresses; those inside the validated networks were checked before any sweep");
		expect(text).toContain("TLS sweep: not run; the DNS history led to a verified origin server (256 public IPv4 addresses would have been swept)");
		expect(text).toContain("- 8.8.8.6 AS64500 8.8.8.0/29; found through the DNS history");
		expect(text).toContain("Historical addresses inside the validated networks (UNVERIFIED: they did not serve the site when checked, and may since belong to another customer):\n- 2a03:b0c0:2:d0::5 AS64500 2a03:b0c0::/32: kit-host.com first seen 2026-11-01T00:00:00.000Z, last seen 2026-11-10T00:00:00.000Z (VirusTotal)");
		expect(text).not.toContain("104.21.46.90");
		expect(text).not.toContain("9.9.9.9");
		const report = (await AbuseRepository.getReport(disclosure.reportId))!;
		const draft = await createAbuseEmailDraft({ report, target: targets.find(({ id }) => id === route.targetId)!, route, recipient: "abuse@host.example", attachmentNames: [], attachmentMimeTypes: [] });
		expect(draft.body).toContain("We found it in login.kit-host.com's DNS history (passive DNS, VirusTotal)");
	});

	test("unverified in-network history is kept, the sweep still runs, and DigitalOcean gets the recent address labelled historical", async () => {
		const disclosure = await cloudflareDisclosure("trk.kit-run.run", "abuse@digitalocean.com", new Date("2026-11-22T06:19:36.000Z"));
		const history = historyOf([
			{ host: "trk.kit-run.run", ip: "104.21.46.90", lastSeen: "2026-11-21T00:00:00.000Z" },
			{ host: "trk.kit-run.run", ip: "2a03:b0c0:2:d0::5", lastSeen: "2026-10-01T00:00:00.000Z" },
			{ host: "trk.kit-run.run", ip: "8.8.8.2", lastSeen: "2026-11-19T10:00:00.000Z" },
			{ host: "kit-run.run", ip: "8.8.8.3", lastSeen: "2026-11-21T10:00:00.000Z" },
		], ["passive DNS virustotal for www.kit-run.run: quota exhausted (HTTP 429)"]);
		const checked: string[][] = [];
		await reportOriginHost({ reportId: disclosure.reportId, messageId: disclosure.messageId }, {
			...quietCase,
			resolveNetworks: network(14061, "DIGITALOCEAN-ASN", ["8.8.8.0/30", "2a03:b0c0::/32"]),
			findServers: async ({ addresses }) => {
				checked.push([...addresses]);
				return [];
			},
			passiveDns: history.passiveDns,
		});
		// History first, then the full sweep of the IPv4 prefixes.
		expect(checked).toEqual([["2a03:b0c0:2:d0::5", "8.8.8.2", "8.8.8.3"], ["8.8.8.0", "8.8.8.1", "8.8.8.2", "8.8.8.3"]]);
		const route = (await disclosure.originRoute())!;
		const snapshot = readOriginHostSnapshot(route.resolutionSnapshot)!;
		expect(snapshot.servers).toEqual([]);
		expect(snapshot.scan.addressesScanned).toBe(4);
		expect(snapshot.historicalResolutions.map(({ host, ip, prefix }) => `${host} ${ip} ${prefix}`)).toEqual([
			"trk.kit-run.run 2a03:b0c0:2:d0::5 2a03:b0c0::/32",
			"trk.kit-run.run 8.8.8.2 8.8.8.0/30",
			"kit-run.run 8.8.8.3 8.8.8.0/30",
		]);
		expect(snapshot.errors).toContain("passive DNS virustotal for www.kit-run.run: quota exhausted (HTTP 429)");

		const report = await digitalOceanReport(route.id);
		// The reported domain's own most recent address in the host's network, not the parent site's newer one.
		expect(report.sourceIp).toBe("8.8.8.2");
		expect(report.details).toContain("Historical address, unverified: before Cloudflare, trk.kit-run.run resolved to 8.8.8.2 in this host's network, last seen 2026-11-19 (passive DNS, VirusTotal); it no longer serves the site, so please check which customer held it then.");
	});

	test("an address the history could not prove but the sweep did is a swept server, no longer history", async () => {
		const disclosure = await cloudflareDisclosure("login.kit-moved.com", "abuse@host.example", new Date("2026-11-22T06:19:36.000Z"));
		const certificate = { names: ["login.kit-moved.com"], notBefore: "2026-11-01T00:00:00.000Z", notAfter: "2027-01-30T00:00:00.000Z", issuer: "C=US, O=Let's Encrypt, CN=R11", fingerprint256: "AA:BB" };
		let calls = 0;
		await reportOriginHost({ reportId: disclosure.reportId, messageId: disclosure.messageId }, {
			...quietCase,
			resolveNetworks: network(64500, "EXAMPLE", ["8.8.8.0/30"]),
			// The server did not answer the history check in time, but answered the sweep.
			findServers: async ({ addresses }) => calls++ === 0 ? [] : addresses.includes("8.8.8.2") ? [{ ip: "8.8.8.2", certificate }] : [],
			passiveDns: historyOf([{ host: "login.kit-moved.com", ip: "8.8.8.2", lastSeen: "2026-11-20T00:00:00.000Z" }]).passiveDns,
		});
		const snapshot = readOriginHostSnapshot((await disclosure.originRoute())!.resolutionSnapshot)!;
		expect(snapshot.servers.map(({ ip, discovery }) => `${ip} ${discovery}`)).toEqual(["8.8.8.2 tls_sweep"]);
		expect(snapshot.historicalResolutions).toEqual([]);
	});

	test("a failed DNS history lookup is recorded and the sweep goes on; without a validated network it is not asked", async () => {
		const failed = await cloudflareDisclosure("login.kit-fail.com", "abuse@host.example", new Date("2026-11-22T06:19:36.000Z"));
		const swept: string[][] = [];
		await reportOriginHost({ reportId: failed.reportId, messageId: failed.messageId }, {
			...quietCase,
			resolveNetworks: network(64500, "EXAMPLE", ["8.8.8.0/30"]),
			findServers: async ({ addresses }) => {
				swept.push([...addresses]);
				return [];
			},
			passiveDns: async () => { throw new Error("resolver exploded"); },
		});
		expect(swept).toEqual([["8.8.8.0", "8.8.8.1", "8.8.8.2", "8.8.8.3"]]);
		const snapshot = readOriginHostSnapshot((await failed.originRoute())!.resolutionSnapshot)!;
		expect(snapshot.errors).toContain("passive DNS: resolver exploded");
		expect(snapshot.dnsHistory).toEqual({ hosts: [], sources: [], recordsFound: 0 });

		const unattributed = await cloudflareDisclosure("login.kit-none.com", "abuse@nowhere.example", new Date("2026-11-22T06:19:36.000Z"));
		const history = historyOf([{ host: "login.kit-none.com", ip: "8.8.8.2", lastSeen: "2026-11-20T00:00:00.000Z" }]);
		await reportOriginHost({ reportId: unattributed.reportId, messageId: unattributed.messageId }, {
			...quietCase,
			resolveNetworks: async () => ({ recipient: "", mailboxDomain: "", networks: [], errors: ["registry search: nothing"] }),
			findServers: async () => { throw new Error("nothing to sweep"); },
			passiveDns: history.passiveDns,
		});
		expect(history.calls).toEqual([]);
		const none = readOriginHostSnapshot((await unattributed.originRoute())!.resolutionSnapshot)!;
		expect(none).toMatchObject({ servers: [], historicalResolutions: [], dnsHistory: { hosts: [], sources: [], recordsFound: 0 } });
	});
});

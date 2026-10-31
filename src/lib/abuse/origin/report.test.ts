import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { ArtifactsEntity, SubmissionsEntity } from "../../db/entities";
import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { createAbuseEmailDraft } from "../mail/draft";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { abuseArtifacts, abuseJobs } from "../schema";
import { readOriginHostSnapshot, type KitCollectedData } from "./snapshot";
import { reportOriginHost } from "./report";

const CLOUDFLARE_RESPONSE = `Hello,

We have also forwarded this report to the relevant hosting provider.
The host for the reported domain is:
abuse@host.example
You may use this information to follow up directly with the hosting provider.`;

describe("origin-host report workflow", () => {
	useTemporaryDatabase();

	test("creates the origin target, evidence, email route, and sibling case idempotently", async () => {
		const submissionId = 410000000000000001n;
		await SubmissionsEntity.create({
			id: submissionId,
			kind: "website",
			data: { kind: "website", website: { url: "https://login.example.com/", siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft" }] } },
			dedupeKey: "website-login.example.com",
			status: "reported",
			source: "https://login.example.com/",
		});
		const capturedCss = Buffer.from(".captured-kit { color: red; }\n".repeat(40));
		const capturedCssSha256 = createHash("sha256").update(capturedCss).digest("hex");
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
				fingerprints: [{ sha256: "a".repeat(64), mimeType: "text/css", url: "https://login.example.com/kit.css", size: 2048 }],
				candidateCount: 2,
				confirmed: [{ domain: "sibling.example.net", url: "https://sibling.example.net/login", matchingHashes: ["a".repeat(64)], originIp: "8.8.8.6", certificate: siblingCertificate }],
				errors: [],
			}),
			createSiblingSubmission: async (options: { url: string; source?: string }) => {
				siblingOptions.push(options);
				return 410000000000000002n;
			},
			kitFacts: async () => ({
				phishingBasis: "credential_theft" as const,
				evidenceQuote: "Sign in with your Example Account",
				collects: ["sign-in email or phone", "password", "one-time 2FA codes"] satisfies KitCollectedData[],
				exfiltrationProbed: true,
				exfiltrationTargets: ["telegram-bot:123456"],
			}),
			registeredAt: async (domain: string) => domain === "sibling.example.net" ? "2026-10-19T08:00:00.000Z" : "2026-09-30T12:00:00.000Z",
			sliceAddresses: 3,
		};

		// Slice 1 sweeps 8.8.8.0-2 and hands its progress to a successor job.
		const queuedJob = async () => (await (await getDb()).select().from(abuseJobs).where(and(eq(abuseJobs.jobType, "report_origin_host"), eq(abuseJobs.status, "queued"))).all());
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
		expect(snapshot.servers[0]).toMatchObject({ ip: "8.8.8.6", asn: 64500, prefix: "8.8.8.0/29" });
		expect(snapshot.scan).toMatchObject({ addressesScanned: 8, totalAddresses: 8, truncated: false });
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

		const sendJobs = await (await getDb()).select().from(abuseJobs).where(and(eq(abuseJobs.jobType, "send_email"), eq(abuseJobs.routeId, originRoute.id))).all();
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
		expect(await (await getDb()).select().from(abuseJobs).where(and(eq(abuseJobs.jobType, "send_email"), eq(abuseJobs.routeId, originRoute.id))).all()).toHaveLength(1);
		expect(await (await getDb()).select().from(abuseArtifacts).where(eq(abuseArtifacts.routeId, originRoute.id)).all()).toHaveLength(1);
	});
});

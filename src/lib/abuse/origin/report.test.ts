import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { SubmissionsEntity } from "../../db/entities";
import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { createAbuseEmailDraft } from "../mail/draft";
import { validateAbuseReportRequest } from "../contracts";
import { AbuseRepository } from "../repository";
import { abuseArtifacts, abuseJobs } from "../schema";
import { readOriginHostSnapshot } from "./snapshot";
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
			data: { kind: "website", website: { url: "https://login.example.com/" } },
			dedupeKey: "website-login.example.com",
			status: "reported",
			source: "https://login.example.com/",
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
		const dependencies = {
			resolveNetworks: async () => ({
				recipient: "abuse@host.example",
				mailboxDomain: "host.example",
				networks: [{ asn: 64500, holder: "Example Hosting GmbH", prefixes: ["8.8.8.8/32"], discoverySources: ["registry_name_search"] }],
				errors: [],
			}),
			findServers: async () => [{
				ip: "8.8.8.8",
				certificate: { names: ["login.example.com"], notBefore: "2026-10-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z", issuer: "Example CA", fingerprint256: "AA:BB" },
			}],
			discoverSiblings: async () => ({
				fingerprints: [{ sha256: "a".repeat(64), mimeType: "text/css", url: "https://login.example.com/kit.css", size: 2048 }],
				candidateCount: 2,
				confirmed: [{ domain: "sibling.example.net", url: "https://sibling.example.net/login", matchingHashes: ["a".repeat(64)], originIp: "8.8.8.8" }],
				errors: [],
			}),
			createSiblingSubmission: async (options: { url: string; source?: string }) => {
				siblingOptions.push(options);
				return 410000000000000002n;
			},
		};

		await reportOriginHost({ reportId: report.id, messageId: stored!.id }, dependencies);
		expect(siblingOptions).toMatchObject([{
			url: "https://sibling.example.net/login",
			source: `origin-sibling:${submissionId.toString()}:${stored!.id.toString()}`,
		}]);
		const targets = await AbuseRepository.listTargets(report.id);
		const originTarget = targets.find(({ normalizedTarget }) => normalizedTarget === "8.8.8.8")!;
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
		expect(snapshot.servers[0]).toMatchObject({ ip: "8.8.8.8", asn: 64500, prefix: "8.8.8.8/32" });
		expect(snapshot.siblings[0]).toMatchObject({ domain: "sibling.example.net", submissionId: "410000000000000002" });
		const artifacts = await AbuseRepository.listRouteArtifacts(originRoute.id, ["origin_host_evidence"]);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]!.blob.toString()).toContain("8.8.8.8 AS64500");
		const draft = await createAbuseEmailDraft({
			report,
			target: originTarget,
			route: originRoute,
			recipient: "abuse@host.example",
			attachmentNames: ["website.png", "origin-host-evidence.txt"],
			attachmentMimeTypes: ["image/png", "text/plain"],
		});
		expect(draft.subject).toContain("Origin-host phishing report for login.example.com");
		expect(draft.body).toContain("Cloudflare identified abuse@host.example");
		expect(draft.body).toContain("sibling.example.net");

		const sendJobs = await (await getDb()).select().from(abuseJobs).where(and(eq(abuseJobs.jobType, "send_email"), eq(abuseJobs.routeId, originRoute.id))).all();
		expect(sendJobs).toHaveLength(1);
		await reportOriginHost({ reportId: report.id, messageId: stored!.id }, {
			resolveNetworks: async () => { throw new Error("must not rescan"); },
			findServers: async () => { throw new Error("must not rescan"); },
			discoverSiblings: async () => { throw new Error("must not rediscover"); },
			createSiblingSubmission: async () => { throw new Error("must not recreate"); },
		});
		expect((await AbuseRepository.listTargets(report.id)).filter(({ normalizedTarget }) => normalizedTarget === "8.8.8.8")).toHaveLength(1);
		expect((await AbuseRepository.listRoutes(report.id)).filter(({ routeKey }) => routeKey === "origin-host:abuse@host.example")).toHaveLength(1);
		expect(await AbuseRepository.listRouteArtifacts(originRoute.id, ["origin_host_evidence"])).toHaveLength(1);
		expect(await (await getDb()).select().from(abuseJobs).where(and(eq(abuseJobs.jobType, "send_email"), eq(abuseJobs.routeId, originRoute.id))).all()).toHaveLength(1);
		expect(await (await getDb()).select().from(abuseArtifacts).where(eq(abuseArtifacts.routeId, originRoute.id)).all()).toHaveLength(1);
	});
});

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { NextRequest } from "next/server";

import { GET as getArtifact } from "../../app/api/abuse/artifacts/[id]/route";
import { GET as getReportStatus } from "../../app/api/abuse/reports/[trackingToken]/route";
import { POST as createReportRoute } from "../../app/api/abuse/reports/route";
import { getDb, resetDatabaseForTesting } from "../db";
import { useTemporaryDatabase } from "../db/test_helpers";
import { validateAbuseReportRequest } from "./contracts";
import { sendAbuseEmailRoute } from "./mail";
import { AbuseRepository, aggregateReportStatus } from "./repository";
import { abuseArtifacts, abuseJobs, abuseMailMessages } from "./schema";
import { createArtifactAccessToken, sha256Hex } from "./security";

useTemporaryDatabase();

const environmentNames = [
	"ABUSE_TRACKING_TOKEN_SECRET",
	"ABUSE_ARTIFACT_TOKEN_SECRET",
	"ABUSE_SMTP_FROM",
	"ABUSE_REPLY_DOMAIN",
] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
	process.env.ABUSE_TRACKING_TOKEN_SECRET = "01234567890123456789012345678901";
	process.env.ABUSE_ARTIFACT_TOKEN_SECRET = "abcdefghijklmnopqrstuvwxyz123456";
	process.env.ABUSE_SMTP_FROM = "Phishing Support <support@phishing.support>";
	process.env.ABUSE_REPLY_DOMAIN = "phishing.support";
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

const reportPayload = {
	targets: ["example.com"],
	allegationCategory: "phishing" as const,
	description: "A credential-harvesting page impersonates the protected brand.",
	observedUrls: [{ target: "example.com", urls: ["https://login.example.com/collect"] }],
	legalBrandUrl: "https://brand.example.com/",
};

async function createStandaloneReport(overrides: Record<string, unknown> = {}) {
	const request = await validateAbuseReportRequest({ ...reportPayload, ...overrides });
	return AbuseRepository.createReport({
		request,
		reporter: { reporterIp: "8.8.8.8", reporterCountry: "US", reporterHeaders: { "user-agent": "abuse-integration-test" } },
	});
}

async function createEmailRoute() {
	const created = await createStandaloneReport();
	const [target] = await AbuseRepository.listTargets(created.reportId);
	if (!target) throw new Error("Test report did not create its target.");
	const route = await AbuseRepository.upsertResolvedRoute(target.id, {
		routeKey: "email:abuse@provider.example",
		providerRegistryKey: "email:provider.example",
		providerDisplayName: "Provider Abuse Desk",
		routeType: "email",
		verifiedEmail: "abuse@provider.example",
		resolverProvenance: { source: "test_explicit_abuse_contact" },
		resolutionSnapshot: { source: "test" },
		status: "verified",
	});
	return { ...created, target, route };
}

async function beginEmailDelivery() {
	const context = await createEmailRoute();
	const execution = await AbuseRepository.beginEmailDelivery({
		routeId: context.route.id,
		providerPayload: { adapter: "generic_email_v1", target: context.target.normalizedTarget },
		correlationKey: `email:${context.route.id.toString()}`,
	});
	if (!execution) throw new Error("Test email route could not be claimed.");
	return { ...context, run: execution.run };
}

describe("standalone abuse persistence boundary", () => {
	test("migrates independently, reopens cleanly, and keeps every abuse foreign key inside the abuse schema", async () => {
		const db = await getDb();
		const client = (db as unknown as { $client: Database }).$client;
		const expectedTables = [
			"abuse_reports",
			"abuse_targets",
			"abuse_provider_routes",
			"abuse_provider_runs",
			"abuse_artifacts",
			"abuse_mail_messages",
			"abuse_mail_codes",
			"abuse_jobs",
			"abuse_events",
			"abuse_webhook_events",
			"abuse_locks",
		];
		const tables = client.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
		expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining(expectedTables));
		for (const table of expectedTables) {
			const foreignKeys = client.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>;
			expect(foreignKeys.every((foreignKey) => foreignKey.table.startsWith("abuse_")), table).toBeTrue();
		}

		await resetDatabaseForTesting();
		const reopened = await getDb();
		const reopenedClient = (reopened as unknown as { $client: Database }).$client;
		expect(reopenedClient.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'abuse_reports'").all()).toHaveLength(1);
	});

	test("uses the same deterministic bearer token only for the same idempotent immutable request", async () => {
		const first = await createStandaloneReport({ idempotencyKey: "abuse-idempotency-key-001" });
		const second = await createStandaloneReport({ idempotencyKey: "abuse-idempotency-key-001" });
		expect(first.created).toBeTrue();
		expect(second).toMatchObject({ reportId: first.reportId, trackingToken: first.trackingToken, created: false });

		await expect(createStandaloneReport({
			idempotencyKey: "abuse-idempotency-key-001",
			description: "This is a materially different allegation.",
		})).rejects.toThrow("already used for a different report");

		const report = await AbuseRepository.getReport(first.reportId);
		const publicStatus = await AbuseRepository.getPublicStatus(first.trackingToken);
		expect(report).toBeDefined();
		expect(publicStatus).toMatchObject({ status: "accepted", targets: [{ target: "example.com" }] });
		const serialized = JSON.stringify(publicStatus);
		expect(serialized).not.toContain(first.reportId.toString());
		expect(serialized).not.toContain(report!.trackingTokenHash);
		expect(serialized).not.toContain(reportPayload.description);
	});

	test("retains repeated bytes as independent immutable artifact occurrences and binds signed reads to one report", async () => {
		const first = await createStandaloneReport();
		const second = await createStandaloneReport({
			targets: ["example.net"],
			observedUrls: [{ target: "example.net", urls: ["https://login.example.net/collect"] }],
		});
		const bytes = Buffer.from("same evidence bytes retained twice");
		const firstArtifact = await AbuseRepository.saveArtifact({
			reportId: first.reportId,
			name: "original.png",
			kind: "user_evidence_original",
			mimeType: "image/png",
			buffer: bytes,
		});
		const derivativeArtifact = await AbuseRepository.saveArtifact({
			reportId: first.reportId,
			name: "provider.jpg",
			kind: "provider_evidence_derivative",
			mimeType: "image/jpeg",
			buffer: bytes,
		});
		expect(firstArtifact).not.toBe(derivativeArtifact);
		expect((await AbuseRepository.listArtifacts(first.reportId)).filter((artifact) => artifact.sha256 === sha256Hex(bytes))).toHaveLength(2);

		const firstReport = await AbuseRepository.getReport(first.reportId);
		const secondReport = await AbuseRepository.getReport(second.reportId);
		if (!firstReport || !secondReport) throw new Error("Test reports were not retained.");
		const validAccess = createArtifactAccessToken(firstArtifact, firstReport.trackingTokenHash);
		const invalidAccess = createArtifactAccessToken(firstArtifact, secondReport.trackingTokenHash);
		const validResponse = await getArtifact(
			new NextRequest(`http://test.local/api/abuse/artifacts/${firstArtifact.toString()}?accessToken=${encodeURIComponent(validAccess)}`),
			{ params: Promise.resolve({ id: firstArtifact.toString() }) },
		);
		expect(validResponse.status).toBe(200);
		expect(await validResponse.text()).toBe(bytes.toString());
		const invalidResponse = await getArtifact(
			new NextRequest(`http://test.local/api/abuse/artifacts/${firstArtifact.toString()}?accessToken=${encodeURIComponent(invalidAccess)}`),
			{ params: Promise.resolve({ id: firstArtifact.toString() }) },
		);
		expect(invalidResponse.status).toBe(404);
	});

	test("exposes anonymous creation and token-only status without a public report listing surface", async () => {
		const response = await createReportRoute(new NextRequest("http://test.local/api/abuse/reports", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(reportPayload),
		}));
		expect(response.status).toBe(202);
		const created = await response.json() as { trackingToken: string; status: string; statusUrl: string };
		expect(created).toMatchObject({ status: "accepted" });
		expect(created.trackingToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(created.statusUrl).toContain(`/abuse-reporting/${created.trackingToken}`);

		const statusResponse = await getReportStatus(
			new Request(`http://test.local/api/abuse/reports/${created.trackingToken}`),
			{ params: Promise.resolve({ trackingToken: created.trackingToken }) },
		);
		expect(statusResponse.status).toBe(200);
		const status = await statusResponse.json() as Record<string, unknown>;
		expect(status).toMatchObject({ status: "accepted" });
		expect(Object.keys(status)).toEqual(["status", "createdAt", "updatedAt", "targets"]);

		const invalid = await createReportRoute(new NextRequest("http://test.local/api/abuse/reports", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...reportPayload, providerUrl: "https://attacker.invalid/portal" }),
		}));
		expect(invalid.status).toBe(400);
		expect((await getReportStatus(new Request("http://test.local/api/abuse/reports/not-a-token"), { params: Promise.resolve({ trackingToken: "not-a-token" }) })).status).toBe(404);
	});
});

describe("standalone abuse email lifecycle", () => {
	test("persists canonical MIME, attachments, and a pending correspondence record before invoking SMTP", async () => {
		const { reportId, route, run } = await beginEmailDelivery();
		let observedBeforeSmtp = false;
		const result = await sendAbuseEmailRoute({
			reportId,
			routeId: route.id,
			runId: run.id,
			recipient: "abuse@provider.example",
			subject: "Automated abuse report",
			body: "Please investigate this phishing target.",
			attachments: [{ filename: "evidence.txt", mimeType: "text/plain", content: Buffer.from("evidence") }],
			correlationKey: run.correlationKey,
			transport: {
				sendMail: async ({ raw, envelope }) => {
					const outbound = await AbuseRepository.getOutboundMailForRun(run.id);
					const artifacts = await AbuseRepository.listArtifacts(reportId);
					expect(outbound).toMatchObject({ status: "pending", direction: "outbound", routeId: route.id, runId: run.id });
					expect(artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining(["outbound_mail_mime", "outbound_mail_attachment"]));
					expect(raw.toString()).toContain("Please investigate this phishing target.");
					expect(envelope).toEqual({ from: "support@phishing.support", to: ["abuse@provider.example"] });
					observedBeforeSmtp = true;
					return { messageId: "smtp-accepted-1" };
				},
			},
		});
		expect(observedBeforeSmtp).toBeTrue();
		expect(result.status).toBe("sent");
		expect(await AbuseRepository.settleEmailDelivery({ runId: run.id, expectedRunStatus: "starting", expectedRouteStatus: "running", outcome: "sent" })).toBeTrue();
		expect(await AbuseRepository.getRoute(route.id)).toMatchObject({ status: "awaiting_provider_reply" });
		expect(await AbuseRepository.getProviderRun(run.id)).toMatchObject({ executionStatus: "delivered" });
	});

	test("treats an explicit SMTP rejection as known delivery failure but fails closed after an ambiguous transport error", async () => {
		const rejected = await beginEmailDelivery();
		const rejection = Object.assign(new Error("recipient rejected"), { responseCode: 550 });
		const rejectedResult = await sendAbuseEmailRoute({
			reportId: rejected.reportId,
			routeId: rejected.route.id,
			runId: rejected.run.id,
			recipient: "abuse@provider.example",
			subject: "Rejected report",
			body: "Report body",
			correlationKey: rejected.run.correlationKey,
			transport: { sendMail: async () => { throw rejection; } },
		});
		expect(rejectedResult).toMatchObject({ status: "failed", error: "recipient rejected" });
		expect(await AbuseRepository.settleEmailDelivery({
			runId: rejected.run.id,
			expectedRunStatus: "starting",
			expectedRouteStatus: "running",
			outcome: "failed",
			failureReason: rejectedResult.error,
		})).toBeTrue();
		expect(await AbuseRepository.getRoute(rejected.route.id)).toMatchObject({ status: "delivery_failed" });

		const ambiguous = await beginEmailDelivery();
		const ambiguousResult = await sendAbuseEmailRoute({
			reportId: ambiguous.reportId,
			routeId: ambiguous.route.id,
			runId: ambiguous.run.id,
			recipient: "abuse@provider.example",
			subject: "Ambiguous report",
			body: "Report body",
			correlationKey: ambiguous.run.correlationKey,
			transport: { sendMail: async () => { throw new Error("connection dropped after DATA"); } },
		});
		expect(ambiguousResult).toMatchObject({ status: "unknown_external_state" });
		expect(await AbuseRepository.getProviderRun(ambiguous.run.id)).toMatchObject({ executionStatus: "starting" });
	});

	test("never converts a post-SMTP persistence failure into a retryable pre-SMTP failure", async () => {
		const context = await beginEmailDelivery();
		const originalSettlement = AbuseRepository.settleOutboundMail;
		(AbuseRepository as unknown as { settleOutboundMail: typeof AbuseRepository.settleOutboundMail }).settleOutboundMail = async (params) => {
			if (params.status === "sent") throw new Error("local write unavailable after SMTP acceptance");
			return originalSettlement(params);
		};
		try {
			const result = await sendAbuseEmailRoute({
				reportId: context.reportId,
				routeId: context.route.id,
				runId: context.run.id,
				recipient: "abuse@provider.example",
				subject: "Post-SMTP persistence test",
				body: "Report body",
				correlationKey: context.run.correlationKey,
				transport: { sendMail: async () => ({ messageId: "smtp-accepted-before-local-failure" }) },
			});
			expect(result).toMatchObject({ status: "unknown_external_state" });
			expect(result.error).toContain("SMTP accepted the message");
		} finally {
			(AbuseRepository as unknown as { settleOutboundMail: typeof AbuseRepository.settleOutboundMail }).settleOutboundMail = originalSettlement;
		}
	});

	test("settles a correlated bounce atomically and refuses a late sent settlement", async () => {
		const context = await beginEmailDelivery();
		let inboundMessageId: bigint | undefined;
		const result = await sendAbuseEmailRoute({
			reportId: context.reportId,
			routeId: context.route.id,
			runId: context.run.id,
			recipient: "abuse@provider.example",
			subject: "Bounce race report",
			body: "Report body",
			correlationKey: context.run.correlationKey,
			transport: {
				sendMail: async () => {
					const outbound = await AbuseRepository.getOutboundMailForRun(context.run.id);
					if (!outbound?.messageId) throw new Error("Outbound MIME was not persisted before SMTP.");
					const inbound = await AbuseRepository.persistInboundMailWithArtifacts({
						reportId: context.reportId,
						routeId: context.route.id,
						kind: "bounce",
						fromAddress: "mailer-daemon@provider.example",
						toAddresses: [outbound.replyAddress!],
						subject: "Delivery Status Notification",
						messageId: "<bounce-race@provider.example>",
						inReplyTo: outbound.messageId,
						references: [outbound.messageId],
						mailbox: "INBOX",
						uidValidity: 1,
						uid: 1,
						rawMime: { name: "bounce-race.eml", buffer: Buffer.from("bounce") },
						attachments: [],
					});
					inboundMessageId = inbound.id;
					expect(await AbuseRepository.settleCorrelatedEmailBounce({ inboundMessageId: inbound.id, retryAfterMs: 0 })).toMatchObject({ settled: true, runId: context.run.id });
					return { messageId: "smtp-accepted-before-bounce" };
				},
			},
		});
		expect(inboundMessageId).toBeDefined();
		expect(result.status).toBe("sent");
		expect(await AbuseRepository.settleEmailDelivery({ runId: context.run.id, expectedRunStatus: "starting", expectedRouteStatus: "running", outcome: "sent" })).toBeFalse();
		expect(await AbuseRepository.getProviderRun(context.run.id)).toMatchObject({ executionStatus: "failed" });
		expect(await AbuseRepository.getRoute(context.route.id)).toMatchObject({ status: "delivery_failed" });
		const db = await getDb();
		const retryJobs = db.select().from(abuseJobs).all().filter((job) => job.routeId === context.route.id && job.jobType === "send_email" && job.status === "queued");
		expect(retryJobs).toHaveLength(1);
		const outbound = await AbuseRepository.getOutboundMailForRun(context.run.id);
		expect(outbound).toMatchObject({ status: "failed" });
	});
});

test("aggregate status never hides a route and preserves explicit terminal outcomes", () => {
	expect(aggregateReportStatus([])).toBe("no_route");
	expect(aggregateReportStatus(["no_route", "insufficient_evidence"])).toBe("insufficient_evidence");
	expect(aggregateReportStatus(["submitted", "no_route"])).toBe("partially_submitted");
	expect(aggregateReportStatus(["submitted", "acknowledged"])).toBe("submitted");
	expect(aggregateReportStatus(["submitted", "unknown_external_state"])).toBe("failed");
	expect(aggregateReportStatus(["needs_human", "submitted"])).toBe("needs_human");
});

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import { ProviderReportsEntity, SubmissionsEntity } from "../db/entities";
import { getDb } from "../db";
import { useTemporaryDatabase } from "../db/test_helpers";
import { handoffConfirmedWebsitePhishing } from "./legacy_website";
import { AbuseRepository } from "./repository";
import { abuseJobs } from "./schema";

useTemporaryDatabase();

const originalTrackingTokenSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;

beforeEach(() => {
	process.env.ABUSE_TRACKING_TOKEN_SECRET = "01234567890123456789012345678901";
});

afterAll(() => {
	if (originalTrackingTokenSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalTrackingTokenSecret;
});

async function pngBuffer(): Promise<Buffer> {
	return sharp({
		create: {
			width: 2,
			height: 2,
			channels: 3,
			background: { r: 20, g: 40, b: 60 },
		},
	})
		.png()
		.toBuffer();
}

async function createLegacyWebsiteSubmission(id: bigint) {
	return SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: "https://login.example.com/collect" } },
		dedupeKey: `legacy-website-bridge-${id.toString()}`,
		status: "running",
		reporterIp: "8.8.8.8",
		reporterCountry: "US",
		reporterHeaders: { "user-agent": "legacy-website-bridge-test" },
	});
}

describe("legacy website-analysis abuse handoff", () => {
	test("creates one standalone report with a durable resolve job and copies a validated archive screenshot", async () => {
		const submissionId = 900001n;
		await createLegacyWebsiteSubmission(submissionId);
		const screenshotPng = await pngBuffer();
		const params = {
			submissionId,
			url: "https://LOGIN.example.com/collect?campaign=credential#captured-fragment",
			analysisText: "The captured page impersonates a bank and asks victims for credentials.",
			screenshotPng,
			reporter: {
				reporterIp: "8.8.8.8",
				reporterCountry: "US",
				reporterHeaders: { "user-agent": "legacy-website-bridge-test" },
			},
		};

		const first = await handoffConfirmedWebsitePhishing(params);
		const replay = await handoffConfirmedWebsitePhishing(params);

		expect(first.created).toBeTrue();
		expect(replay).toEqual({ reportId: first.reportId, trackingToken: first.trackingToken, created: false });

		const [target] = await AbuseRepository.listTargets(first.reportId);
		expect(target).toMatchObject({
			normalizedTarget: "login.example.com",
			targetType: "domain",
			observedUrls: ["https://login.example.com/collect?campaign=credential"],
		});

		const report = await AbuseRepository.getReport(first.reportId);
		expect(report).toMatchObject({
			allegationCategory: "phishing",
			description: params.analysisText,
			reporterIdentity: "service",
			requesterIp: "8.8.8.8",
			requesterCountry: "US",
			requesterHeaders: { "user-agent": "legacy-website-bridge-test" },
			idempotencyKey: `legacy-website:${submissionId.toString()}`,
		});

		const artifacts = await AbuseRepository.listArtifacts(first.reportId);
		expect(artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining(["original_request", "user_evidence_original"]));
		const screenshot = artifacts.find((artifact) => artifact.kind === "user_evidence_original");
		expect(screenshot).toMatchObject({ name: "website.png", mimeType: "image/png", size: screenshotPng.byteLength });
		expect((await AbuseRepository.getArtifact(first.reportId, screenshot!.id))?.blob.equals(screenshotPng)).toBeTrue();

		const db = await getDb();
		const jobs = db.select().from(abuseJobs).where(eq(abuseJobs.reportId, first.reportId)).all();
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({ jobType: "resolve_report", status: "queued", routeId: null });
		// No website report is sent through the legacy provider-report table.
		expect(await ProviderReportsEntity.listForSubmission(submissionId)).toEqual([]);
	});

	test("does not let an invalid optional archive screenshot block the durable reporting handoff", async () => {
		const created = await handoffConfirmedWebsitePhishing({
			submissionId: 900002n,
			url: "https://login.example.net/collect",
			analysisText: "The captured page is a credential-harvesting phishing site.",
			screenshotPng: Buffer.from("not a decodable image"),
			reporter: {},
		});

		expect(created.created).toBeTrue();
		expect((await AbuseRepository.listArtifacts(created.reportId)).map((artifact) => artifact.kind)).toEqual(["original_request"]);
	});
});

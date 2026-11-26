import { describe, expect, test } from "bun:test";

import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionRetriesEntity } from "../db/entities/submission_retries";
import { SubmissionsEntity } from "../db/entities/submissions";
import { AnalysisRunsEntity } from "../db/entities/analysis_runs";
import { useTemporaryDatabase } from "../db/test_helpers";
import { getDb } from "../db";
import { submissionRetries } from "../db/schema";
import { eq } from "drizzle-orm";
import { SubmissionRetryError, emailSubmissionDedupeKey, retryEmailAnalysis } from "./email";

useTemporaryDatabase();

describe("emailSubmissionDedupeKey", () => {
	test("deduplicates an exact source message without collapsing unrelated mail from the same sender", () => {
		const first = [
			"From: sender@example.test",
			"Subject: First phishing lure",
			"",
			"Open https://phish.example.test/first",
		].join("\r\n");
		const second = [
			"From: sender@example.test",
			"Subject: Second phishing lure",
			"",
			"Open https://phish.example.test/second",
		].join("\r\n");

		expect(emailSubmissionDedupeKey(first)).toMatch(/^email:[a-f0-9]{64}$/);
		expect(emailSubmissionDedupeKey(first)).toBe(emailSubmissionDedupeKey(first));
		expect(emailSubmissionDedupeKey(second)).not.toBe(emailSubmissionDedupeKey(first));
	});

});

describe("retryEmailAnalysis", () => {
	const EML = ["From: sender@example.test", "To: reporter@example.test", "Subject: Verify your mailbox", "", "Open https://phish.example.test/"].join("\r\n");

	async function emailCase(id: bigint, status: "failed" | "invalid", withSource = true) {
		await SubmissionsEntity.create({ id, kind: "email", data: { kind: "email" }, dedupeKey: `email-retry-${id}`, status });
		if (withSource) await ArtifactsEntity.saveBuffer({ submissionId: id, name: "mail.eml", kind: "eml", mimeType: "message/rfc822", buffer: Buffer.from(EML) });
		return id;
	}

	test("a missing source is refused before the claim: the case stays retryable and no retry is recorded", async () => {
		const id = await emailCase(1n, "failed", false);
		const analyzed: string[] = [];
		await expect(retryEmailAnalysis(id, async (eml) => { analyzed.push(eml); })).rejects.toBeInstanceOf(SubmissionRetryError);
		expect((await SubmissionsEntity.get(id))?.status).toBe("failed");
		expect(await SubmissionRetriesEntity.listForSubmission(id)).toEqual([]);
		expect(analyzed).toEqual([]);
	});

	test("a mail judged not phishing is analyzed again from its original source after its completed runs; its reporter hears again only of a changed verdict", async () => {
		const id = await emailCase(2n, "invalid");
		for (const kind of ["analysis", "classification"] as const) await AnalysisRunsEntity.complete(await AnalysisRunsEntity.create(id, kind));
		const analyzed: Array<{ eml: string; options: unknown }> = [];
		await retryEmailAnalysis(id, async (eml, _id, options) => { analyzed.push({ eml, options }); });

		expect(analyzed).toEqual([{ eml: EML, options: { reuseEvidenceArtifacts: true, reporterToldNotPhishing: true } }]);
		expect((await SubmissionsEntity.get(id))?.status).toBe("running");
		expect(await SubmissionRetriesEntity.listForSubmission(id)).toEqual([expect.objectContaining({ submissionId: id, fromStatus: "invalid", previousInfo: null, previousFinding: null, trigger: "manual" })]);
	});

	test("a failed mail's retry tells the reporter whatever it finds: they heard nothing yet", async () => {
		const id = await emailCase(3n, "failed");
		await SubmissionsEntity.update(id, { info: "OpenAI request timed out" });
		const options: unknown[] = [];
		await retryEmailAnalysis(id, async (_eml, _id, given) => { options.push(given); });
		expect(options).toEqual([{ reuseEvidenceArtifacts: true, reporterToldNotPhishing: false }]);
		expect(await SubmissionRetriesEntity.listForSubmission(id)).toEqual([expect.objectContaining({ fromStatus: "failed", previousInfo: "OpenAI request timed out", trigger: "manual" })]);
	});

	test("a mail judged not phishing whose retry failed is not reported as not phishing a second time", async () => {
		const id = await emailCase(4n, "invalid");
		const options: unknown[] = [];
		const analyze = async (_eml: string, _id: bigint, given: unknown) => { options.push(given); };
		await retryEmailAnalysis(id, analyze);
		// The retry failed; once the cooldown passed, it is retried again from failed.
		await SubmissionsEntity.update(id, { status: "failed", info: "OpenAI request timed out" });
		const db = await getDb();
		await db.update(submissionRetries).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(submissionRetries.submissionId, id));
		await retryEmailAnalysis(id, analyze);

		expect(options).toEqual([
			{ reuseEvidenceArtifacts: true, reporterToldNotPhishing: true },
			{ reuseEvidenceArtifacts: true, reporterToldNotPhishing: true },
		]);
	});
});

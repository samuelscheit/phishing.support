import { describe, expect, test } from "bun:test";
import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import type { ResponseInputItem } from "openai/resources/responses/responses.mjs";

import { blobFilePath, writeBlob } from "../blobs";
import { compactDatabaseStorage } from "../compact_storage";
import { getDb } from "../index";
import { useTemporaryDatabase } from "../test_helpers";
import { AnalysisRunsEntity, stripInputImages } from "./analysis_runs";
import { ArtifactsEntity } from "./artifacts";
import { SubmissionsEntity } from "./submissions";

const { fileName } = useTemporaryDatabase();

const screenshot = (size: number) => `data:image/png;base64,${Buffer.alloc(size, 7).toString("base64")}`;

/** A model input as the website analysis sends it: text with the screenshot of the page. */
const inputWithScreenshot = (size = 1_000): ResponseInputItem[] => [
	{ role: "system", content: [{ type: "input_text", text: "Judge the page." }] },
	{ role: "user", content: [{ type: "input_text", text: "The page:" }, { type: "input_image", image_url: screenshot(size), detail: "high" }] },
] as ResponseInputItem[];

const withoutScreenshot: ResponseInputItem[] = [
	{ role: "system", content: [{ type: "input_text", text: "Judge the page." }] },
	{ role: "user", content: [{ type: "input_text", text: "The page:" }] },
] as ResponseInputItem[];

async function caseId() {
	return SubmissionsEntity.create({ kind: "website", data: { kind: "website", website: { url: "https://kit.example/" } }, dedupeKey: `runs-${Math.random()}`, status: "running" });
}

const storedInput = async (runId: bigint) => (await getDb()).$client.query("SELECT input FROM analysis_runs WHERE id = ?").get(runId) as { input: string | null };

describe("an analysis run's input", () => {
	test("is stored without the screenshots it sent, on create and on update", async () => {
		const submissionId = await caseId();
		const runId = await AnalysisRunsEntity.create(submissionId, "analysis", inputWithScreenshot());
		expect(JSON.parse((await storedInput(runId)).input!)).toEqual(withoutScreenshot);

		await AnalysisRunsEntity.update(runId, { input: inputWithScreenshot() });
		expect(JSON.parse((await storedInput(runId)).input!)).toEqual(withoutScreenshot);
		// An update without input leaves it alone.
		await AnalysisRunsEntity.update(runId, { tokensUsed: 5 });
		expect(JSON.parse((await storedInput(runId)).input!)).toEqual(withoutScreenshot);

		// A run without input stays without.
		const bare = await AnalysisRunsEntity.create(submissionId, "classification");
		expect((await storedInput(bare)).input).toBeNull();
	});

	test("loses every screenshot at any depth and any image inlined as a data: URL, and keeps everything else", () => {
		const nested = [
			{ type: "input_image", image_url: "https://cdn.example/x.png" },
			{ type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "shot" }, { type: "input_image", image_url: screenshot(10) }] },
			{ role: "user", content: [{ type: "input_text", text: `inline ${"data:image/png;base64,AAAA"}` }, { type: "input_file", file_data: "data:image/jpeg;base64,/9j/4AAQ" }] },
			{ role: "user", content: "data:image/svg+xml;utf8,<svg/>" },
			{ role: "assistant", content: [{ type: "output_text", text: "a data:image/png;base64 mention is text", annotations: [] }], meta: { count: 3, ok: true, none: null } },
		];
		expect(stripInputImages(nested)).toEqual([
			{ type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "shot" }] },
			// Only a value that is an image, not text that mentions one, is replaced.
			{ role: "user", content: [{ type: "input_text", text: `inline ${"data:image/png;base64,AAAA"}` }, { type: "input_file", file_data: "[image/jpeg omitted]" }] },
			{ role: "user", content: "[image/svg+xml omitted]" },
			{ role: "assistant", content: [{ type: "output_text", text: "a data:image/png;base64 mention is text", annotations: [] }], meta: { count: 3, ok: true, none: null } },
		]);
		expect(stripInputImages(null)).toBeNull();
		expect(stripInputImages(withoutScreenshot)).toEqual(withoutScreenshot);
	});

	test("listed for its case is stripped too, also when stored before stripping", async () => {
		const submissionId = await caseId();
		const runId = await AnalysisRunsEntity.create(submissionId, "analysis");
		(await getDb()).$client.run("UPDATE analysis_runs SET input = ? WHERE id = ?", [JSON.stringify(inputWithScreenshot()), runId]);
		expect((await AnalysisRunsEntity.listForSubmission(submissionId))[0]!.input).toEqual(withoutScreenshot);
	});
});

describe("compactDatabaseStorage", () => {
	test("strips stored screenshots, removes old blobs no artifact names, and gives the space back", async () => {
		const submissionId = await caseId();
		const client = (await getDb()).$client;
		// Runs stored before inputs were stripped: 60 with a 200 kB screenshot each, more than one batch.
		const runIds: bigint[] = [];
		for (let index = 0; index < 60; index++) {
			const runId = await AnalysisRunsEntity.create(submissionId, "analysis");
			client.run("UPDATE analysis_runs SET input = ? WHERE id = ?", [JSON.stringify(inputWithScreenshot(150_000)), runId]);
			runIds.push(runId);
		}
		const clean = await AnalysisRunsEntity.create(submissionId, "analysis", withoutScreenshot);

		const referenced = await ArtifactsEntity.saveBuffer({ submissionId, kind: "website_png", buffer: Buffer.from("kept") });
		const referencedSha = (await ArtifactsEntity.get(referenced))!.sha256;
		const orphan = writeBlob(Buffer.from("no row names me"));
		const fresh = writeBlob(Buffer.from("my row is being written"));
		const temp = `${blobFilePath(orphan.sha256)}.abandoned.tmp`;
		writeFileSync(temp, "half");
		const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
		for (const path of [blobFilePath(referencedSha), blobFilePath(orphan.sha256), temp]) utimesSync(path, twoHoursAgo, twoHoursAgo);

		const before = statSync(fileName).size + statSync(`${fileName}-wal`).size;
		const result = await compactDatabaseStorage();

		expect(result).toMatchObject({ runsCompacted: 60, orphanBlobsRemoved: 2 });
		expect(result.inputBytesFreed).toBeGreaterThan(60 * 200_000);
		expect(result.databaseBytesBefore).toBe(before);
		expect(result.databaseBytesAfter).toBeLessThan(before / 5);
		expect(statSync(fileName).size).toBe(result.databaseBytesAfter);
		for (const runId of runIds) expect(JSON.parse((await storedInput(runId)).input!)).toEqual(withoutScreenshot);
		expect(JSON.parse((await storedInput(clean)).input!)).toEqual(withoutScreenshot);
		expect(existsSync(blobFilePath(referencedSha))).toBeTrue();
		expect(existsSync(blobFilePath(fresh.sha256))).toBeTrue();
		expect(existsSync(blobFilePath(orphan.sha256))).toBeFalse();
		expect(existsSync(temp)).toBeFalse();
		expect((await ArtifactsEntity.get(referenced))!.blob.toString()).toBe("kept");

		// Nothing is left to do, and a younger minimum age takes the fresh orphan too.
		expect(await compactDatabaseStorage({ minAgeMs: 0 })).toMatchObject({ runsCompacted: 0, inputBytesFreed: 0, orphanBlobsRemoved: 1 });
		expect(existsSync(blobFilePath(fresh.sha256))).toBeFalse();
		expect(existsSync(blobFilePath(referencedSha))).toBeTrue();
	});
});

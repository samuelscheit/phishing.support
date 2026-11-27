import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { POST as submitWebsite } from "@/app/api/submissions/website/route";
import { POST as retrySubmission } from "@/app/api/submissions/[id]/retry/route";
import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import type { ReporterInstructions } from "./instructions";
import { createWebsiteSubmission, retryWebsiteAnalysis } from "./website";
import type { AnalyzeWebsiteOptions } from "../website/analysis/ai";
import { runQueuedVisits } from "../website/visit_queue/test_helpers";

useTemporaryDatabase();

const URL = "https://bank-login.example/";

function submit(body: unknown) {
	return submitWebsite(new NextRequest("http://localhost/api/submissions/website", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
}

function retry(id: bigint, body?: string) {
	return retrySubmission(new Request(`http://localhost/api/submissions/${id}/retry`, { method: "POST", ...(body === undefined ? {} : { body }) }), { params: Promise.resolve({ id: String(id) }) });
}

async function websiteCase(id: bigint, instructions?: ReporterInstructions) {
	await SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url: URL, ...(instructions ? { instructions } : {}) } }, dedupeKey: `instructions-${id}`, status: "failed" });
	return id;
}

/** Runs the queued visits with a fake analysis that records what it was given. */
async function visit() {
	const started: AnalyzeWebsiteOptions[] = [];
	await runQueuedVisits(async (options) => { started.push(options); });
	return started;
}

const stored = async (id: bigint) => {
	const submission = await SubmissionsEntity.get(id);
	return submission?.data.kind === "website" ? submission.data.website.instructions : "not a website";
};

describe("submitting a website with instructions", () => {
	test("rejects invalid instructions with 400 before any case is opened", async () => {
		for (const instructions of [{ browser: "x".repeat(2_001) }, { analysis: 7 }, "click", ["click"]]) {
			const response = await submit({ url: URL, instructions });
			expect(response.status).toBe(400);
			expect((await response.json()).error).toContain("instructions");
		}
		expect(await SubmissionsEntity.get(1n)).toBeUndefined();
	});

	test("stores trimmed instructions with the case and hands them to the analysis", async () => {
		const { id } = await createWebsiteSubmission({ url: URL, instructions: { browser: "Click 'Download PDF'.", analysis: "It impersonates Example Bank." } });
		const started = await visit();
		expect(await stored(id)).toEqual({ browser: "Click 'Download PDF'.", analysis: "It impersonates Example Bank." });
		expect(started[0]!.instructions).toEqual({ browser: "Click 'Download PDF'.", analysis: "It impersonates Example Bank." });
	});

	test("a case without instructions stores none", async () => {
		const { id } = await createWebsiteSubmission({ url: "https://other.example/" });
		const started = await visit();
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.data).toEqual({ kind: "website", website: { url: "https://other.example/" } });
		expect(started[0]!.instructions).toBeUndefined();
	});
});

describe("analyzing a website case again", () => {
	test("keeps the stored instructions when the retry brings none", async () => {
		const id = await websiteCase(11n, { browser: "Open the menu.", analysis: "Fake bank." });
		await retryWebsiteAnalysis(id);
		const started = await visit();
		expect(started[0]!.instructions).toEqual({ browser: "Open the menu.", analysis: "Fake bank." });
		expect(await stored(id)).toEqual({ browser: "Open the menu.", analysis: "Fake bank." });
	});

	test("replaces the stored instructions with the retry's", async () => {
		const id = await websiteCase(12n, { browser: "Open the menu.", analysis: "Fake bank." });
		await retryWebsiteAnalysis(id, { instructions: { analysis: "Fake insurer." } });
		const started = await visit();
		expect(started[0]!.instructions).toEqual({ analysis: "Fake insurer." });
		expect(await stored(id)).toEqual({ analysis: "Fake insurer." });
	});

	test("clears the stored instructions when the retry's are empty", async () => {
		const id = await websiteCase(13n, { browser: "Open the menu." });
		await retryWebsiteAnalysis(id, { instructions: undefined });
		const started = await visit();
		expect(started[0]!.instructions).toBeUndefined();
		expect(await stored(id)).toBeUndefined();
	});

	test("a case that never had instructions gets the retry's", async () => {
		const id = await websiteCase(14n);
		await retryWebsiteAnalysis(id, { instructions: { browser: "Accept the cookies first." } });
		const started = await visit();
		expect(started[0]!.instructions).toEqual({ browser: "Accept the cookies first." });
		expect(await stored(id)).toEqual({ browser: "Accept the cookies first." });
	});

	test("the retry route rejects invalid instructions and bodies with 400 and leaves the case alone", async () => {
		const id = await websiteCase(15n, { browser: "Open the menu." });
		for (const body of [JSON.stringify({ instructions: { browser: "x".repeat(2_001) } }), JSON.stringify({ instructions: { analysis: false } }), JSON.stringify({ instructions: "x" }), "{not json", "[]", "null"]) {
			const response = await retry(id, body);
			expect(response.status).toBe(400);
		}
		const submission = await SubmissionsEntity.get(id);
		expect(submission?.status).toBe("failed");
		expect(await stored(id)).toEqual({ browser: "Open the menu." });
	});

	test("the retry route refuses instructions for an email case", async () => {
		await SubmissionsEntity.create({ id: 16n, kind: "email", data: { kind: "email" }, dedupeKey: "instructions-email", status: "failed" });
		const response = await retry(16n, JSON.stringify({ instructions: { analysis: "x" } }));
		expect(response.status).toBe(400);
		expect((await response.json()).error).toBe("Instructions apply only to website submissions");
		expect((await SubmissionsEntity.get(16n))?.status).toBe("failed");
	});
});

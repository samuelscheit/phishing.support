import { describe, expect, test } from "bun:test";

import { ProviderSubmissionRejectedError } from "../submission_contracts";
import type { EranetSession } from "./submission";
import { submitEranetSupplement } from "./supplement";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** Eranet's form as a test double: every call in order, answering as the portal does. */
function form(answers: Record<string, Record<string, unknown>> = {}) {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	let closed = false;
	let uploads = 0;
	const session: EranetSession = {
		call: async (path, body) => {
			calls.push({ path, body: "json" in body ? body.json : { type: body.upload.type, filename: body.upload.filename } });
			if (answers[path]) return answers[path]!;
			if (path === "UploadFile") return { Data: { filename: `uploaded-${++uploads}.png` } };
			return { RequestId: "r" };
		},
		close: async () => { closed = true; },
	};
	return { calls, session, isClosed: () => closed };
}

const answer = {
	confirmationId: "19ef5c75-d0c5-43f4-a7cc-4e711b80fa47",
	body: "Hello Eranet Trust & Safety,\n\nThis is about report 19ef5c75-d0c5-43f4-a7cc-4e711b80fa47 (binanceusa.org).",
	attachments: [
		{ filename: "recheck.png", mimeType: "image/png", content: PNG },
		{ filename: "website.mhtml", mimeType: "multipart/related", content: Buffer.from("mhtml") },
		{ filename: "website.png", mimeType: "image/png", content: PNG },
	],
};

describe("Eranet supplement", () => {
	test("uploads the screenshots, waits for the mailed code, records the answer, then files it once", async () => {
		const { calls, session, isClosed } = form();
		const order: string[] = [];
		await submitEranetSupplement(answer, async () => { order.push(`marked after ${calls.length} calls`); }, {
			openSession: async () => session,
			readCode: async () => "123456",
		});
		expect(calls.map(({ path, body }) => `${path} ${JSON.stringify(body)}`)).toEqual([
			`UploadFile {"type":"ownershipProof","filename":"recheck.png"}`,
			`UploadFile {"type":"ownershipProof","filename":"website.png"}`,
			`GetEmailCode {"Email":"support@phishing.support","AliyunCaptchaVerifyParam":""}`,
			`Supplement {"OrderNo":"19ef5c75-d0c5-43f4-a7cc-4e711b80fa47","Email":"support@phishing.support","Code":"123456","Contents":${JSON.stringify(answer.body)},"Files":"uploaded-1.png,uploaded-2.png"}`,
		]);
		// Recorded after the code and before the one request that files the answer.
		expect(order).toEqual(["marked after 3 calls"]);
		expect(isClosed()).toBeTrue();
	});

	test("an answer without a screenshot is refused before any request: the form requires one", async () => {
		let opened = false;
		await expect(submitEranetSupplement({ ...answer, attachments: [answer.attachments[1]!] }, async () => {}, { openSession: async () => { opened = true; return form().session; } }))
			.rejects.toThrow("requires a screenshot");
		expect(opened).toBeFalse();
	});

	test("a failed code mail is a safe retry: nothing is recorded or filed", async () => {
		const { calls, session, isClosed } = form({ GetEmailCode: { error: "Frequent.Operation" } });
		let marked = false;
		await expect(submitEranetSupplement(answer, async () => { marked = true; }, { openSession: async () => session, readCode: async () => "123456" })).rejects.toThrow("did not send its verification code");
		expect(marked).toBeFalse();
		expect(calls.some(({ path }) => path === "Supplement")).toBeFalse();
		expect(isClosed()).toBeTrue();
	});

	test("Eranet's named refusal of the filing request is a rejection, not an ambiguity", async () => {
		const { session } = form({ Supplement: { error: "VerifyCode.NotFound.Code" } });
		await expect(submitEranetSupplement(answer, async () => {}, { openSession: async () => session, readCode: async () => "123456" }))
			.rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
	});
});

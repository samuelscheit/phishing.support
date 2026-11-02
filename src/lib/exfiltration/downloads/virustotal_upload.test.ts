import { describe, expect, test } from "bun:test";

import { uploadToVirusTotal, VIRUSTOTAL_DIRECT_UPLOAD_LIMIT_BYTES } from "./virustotal_upload";

const bytes = Buffer.from("synthetic-probe-download-for-upload-tests");

describe("VirusTotal upload", () => {
	test("posts the file as the documented multipart field with the key in x-apikey and a safe leaf name", async () => {
		let url = "";
		let headers: Record<string, string> = {};
		let form: FormData | undefined;
		const result = await uploadToVirusTotal({
			bytes,
			apiKey: " vt-key ",
			fileName: "sample-0f3c.bin",
			fetch: async (input, init) => {
				url = String(input);
				headers = init?.headers as Record<string, string>;
				form = init?.body as FormData;
				return Response.json({ data: { type: "analysis", id: "analysis-123" } });
			},
		});
		expect(url).toBe("https://www.virustotal.com/api/v3/files");
		expect(headers["x-apikey"]).toBe("vt-key");
		expect(form?.has("file")).toBeTrue();
		const sent = form?.get("file") as File;
		expect(sent.name).toBe("sample-0f3c.bin");
		expect(result).toEqual({ state: "submitted", analysisId: "analysis-123" });
	});

	test("a missing key uploads nothing and is not_configured", async () => {
		let calls = 0;
		expect(await uploadToVirusTotal({ bytes, apiKey: undefined, fileName: "a.bin", fetch: async () => { calls++; return new Response("{}"); } }))
			.toEqual({ state: "not_attempted", reason: "not_configured" });
		expect(calls).toBe(0);
	});

	test("a file over the direct-upload limit is refused before any request, and not silently skipped", async () => {
		let calls = 0;
		const oversize = Buffer.alloc(VIRUSTOTAL_DIRECT_UPLOAD_LIMIT_BYTES + 1);
		expect(await uploadToVirusTotal({ bytes: oversize, apiKey: "k", fileName: "a.bin", fetch: async () => { calls++; return new Response("{}"); } }))
			.toEqual({ state: "not_attempted", reason: "too_large" });
		expect(calls).toBe(0);
	});

	test("a response that is not an analysis object is a failure, never a submission", async () => {
		expect(await uploadToVirusTotal({ bytes, apiKey: "k", fileName: "a.bin", fetch: async () => Response.json({ data: "http://upload.example/url" }) }))
			.toEqual({ state: "failed", reason: "response is not an analysis object" });
	});

	test("a rejected request is a failure, with the HTTP status and no body echoed", async () => {
		expect(await uploadToVirusTotal({ bytes, apiKey: "k", fileName: "a.bin", fetch: async () => new Response("secret-body-text", { status: 429 }) }))
			.toEqual({ state: "failed", reason: "HTTP 429" });
	});

	test("a transport failure is a failure, not a submission", async () => {
		expect(await uploadToVirusTotal({ bytes, apiKey: "k", fileName: "a.bin", fetch: async () => { throw new TypeError("fetch failed"); } }))
			.toEqual({ state: "failed", reason: "transport failure" });
	});
});

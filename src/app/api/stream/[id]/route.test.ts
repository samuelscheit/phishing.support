import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { GET } from "./route";
import { publishEvent } from "@/lib/event/event_transport";

async function readStream(response: Response): Promise<string> {
	const reader = response.body!.getReader() as ReadableStreamDefaultReader<unknown>;
	let body = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) return body;
		body += typeof chunk.value === "string" ? chunk.value : new TextDecoder().decode(chunk.value as ArrayBufferView);
	}
}

describe("analysis SSE route", () => {
	test("progress mode forwards only high-level steps until the whole pipeline is done", async () => {
		const id = `route-test-progress-${Date.now()}-${Math.random()}`;
		const response = await GET(new NextRequest(`http://localhost/api/stream/${id}?progress=1`), {
			params: Promise.resolve({ id }),
		});
		const bodyPromise = readStream(response);
		await publishEvent(`run:${id}`, { type: "response.output_item.added", sequence_number: 1, item: { encrypted_content: "secret" } });
		await publishEvent(`run:${id}`, { type: "analysis.step", step: "analysis_run", progress: 45 });
		await publishEvent(`run:${id}`, { type: "analysis.step", step: "completed", progress: 100 });

		const body = await bodyPromise;
		expect(body).toContain('"type":"connected"');
		expect(body).toContain('"type":"analysis.step"');
		expect(body).not.toContain("response.output_item.added");
		expect(body).not.toContain("secret");
		expect(body).toContain('"step":"completed"');
	});

	test("sends a safe projection for regular analysis streams and closes at run completion", async () => {
		const id = `route-test-regular-${Date.now()}-${Math.random()}`;
		const response = await GET(new NextRequest(`http://localhost/api/stream/${id}`), {
			params: Promise.resolve({ id }),
		});
		const bodyPromise = readStream(response);
		await publishEvent(`run:${id}`, {
			type: "response.output_item.done",
			sequence_number: 1,
			item: {
				id: "reasoning",
				type: "reasoning",
				encrypted_content: "secret",
				summary: [{ type: "summary_text", text: "Checking the evidence" }],
			},
		});
		await publishEvent(`run:${id}`, {
			type: "response.output_item.done",
			sequence_number: 2,
			item: { id: "search", type: "web_search_call", status: "completed", action: { queries: ["private search term"] } },
		});
		// An item may carry its own completed status; that must not terminate the
		// stream before the run-level completion marker arrives.
		await publishEvent(`run:${id}`, { type: "response.output_item.added", status: "completed", sequence_number: 2 });
		await publishEvent(`run:${id}`, { type: "run.completed", runId: BigInt(123) });

		const body = await bodyPromise;
		expect(body).toContain('"type":"connected"');
		expect(body).toContain('"type":"response.output_item.done"');
		expect(body).toContain("Checking the evidence");
		expect(body).not.toContain("secret");
		expect(body).not.toContain("private search term");
		expect(body).toContain('"query_count":1');
		expect(body).toContain('"type":"run.completed"');
		expect(body).toContain('"type":"response.output_item.added"');
	});
});

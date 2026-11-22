import { describe, expect, test } from "bun:test";
import { serviceUserAgent } from "../../../network/service_identity";

import {
	fetchNetcraftSubmissionState,
	netcraftSubmissionUrl,
	parseNetcraftSubmissionResponse,
} from "./api";

describe("Netcraft submission receipt parsing", () => {
	test("accepts compact, RFC 4122, and opaque live submission identifiers", async () => {
		const compact = "AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
		const hyphenated = "123E4567-E89B-12D3-A456-426614174000";
		const opaque = "lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV";

		await expect(parseNetcraftSubmissionResponse(
			new Response(JSON.stringify({ uuid: compact, message: "Successfully reported" })),
		)).resolves.toEqual({
			uuid: compact.toLowerCase(),
			message: "Successfully reported",
			submissionUrl: `https://report.netcraft.com/api/v3/submission/${compact.toLowerCase()}`,
		});

		await expect(parseNetcraftSubmissionResponse(
			new Response(JSON.stringify({ uuid: hyphenated })),
		)).resolves.toEqual({
			uuid: hyphenated.toLowerCase(),
			submissionUrl: `https://report.netcraft.com/api/v3/submission/${hyphenated.toLowerCase()}`,
		});
		expect(netcraftSubmissionUrl(hyphenated)).toBe(`https://report.netcraft.com/api/v3/submission/${hyphenated.toLowerCase()}`);

		await expect(parseNetcraftSubmissionResponse(
			new Response(JSON.stringify({ uuid: opaque, message: "Successfully reported" })),
		)).resolves.toEqual({
			uuid: opaque,
			message: "Successfully reported",
			submissionUrl: `https://report.netcraft.com/api/v3/submission/${opaque}`,
		});
		expect(netcraftSubmissionUrl(opaque)).toBe(`https://report.netcraft.com/api/v3/submission/${opaque}`);
	});

	test("keeps an unconfirmed successful response ambiguous but preserves bounded provider diagnostics", async () => {
		await expect(parseNetcraftSubmissionResponse(
			new Response(JSON.stringify({ message: "Accepted without an identifier", status: "accepted" })),
		)).rejects.toThrow('Netcraft report did not include a valid submission UUID: {"message":"Accepted without an identifier","status":"accepted"}');
	});

	test("rejects URL-shaped, malformed, and unsafe submission identifiers", () => {
		expect(() => netcraftSubmissionUrl("https://attacker.example/")).toThrow("invalid submission UUID");
		expect(() => netcraftSubmissionUrl("123e4567-e89b-12d3-a456-42661417400z")).toThrow("invalid submission UUID");
		expect(() => netcraftSubmissionUrl("lFQ9vJzdwxWau2LTPeu665VWSCpxiFG")).toThrow("invalid submission UUID");
		expect(() => netcraftSubmissionUrl("lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV/")).toThrow("invalid submission UUID");
	});

	test("reads a bounded submission state without making a write request", async () => {
		const opaque = "lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV";
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const result = await fetchNetcraftSubmissionState({
			uuid: opaque,
			fetch: async (url, init) => {
				requests.push({ url: String(url), init });
				return new Response(JSON.stringify({ state: "processing", pending: 0, has_urls: 1, last_update: 1_788_177_992 }));
			},
		});

		expect(result).toEqual({ uuid: opaque, state: "processing", pending: false, hasUrls: true, lastUpdate: 1_788_177_992 });
		expect(requests.map(({ url }) => url)).toEqual([netcraftSubmissionUrl(opaque)]);
		expect(requests.every(({ init }) => init?.method === "GET" && init?.redirect === "error")).toBeTrue();
		expect(requests.map(({ init }) => new Headers(init?.headers).get("user-agent"))).toEqual([serviceUserAgent]);
	});

	test("fails closed when a state response is malformed", async () => {
		const opaque = "lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV";
		const read = (body: Response) => fetchNetcraftSubmissionState({ uuid: opaque, fetch: async () => body });
		await expect(read(new Response("not json"))).rejects.toThrow("submission-status request returned malformed JSON");
		await expect(read(new Response(JSON.stringify({ state: "processing", pending: 0, has_urls: 1, uuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })))).rejects.toThrow("submission-status response did not match");
		await expect(read(new Response(JSON.stringify({ state: "processing", pending: 0, has_urls: 1, warnings: ["provider warning"] })))).rejects.toThrow("submission-status response did not match");
	});
});

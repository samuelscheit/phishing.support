import { describe, expect, test } from "bun:test";

import {
	fetchNetcraftSubmissionStatus,
	netcraftSubmissionIdFromDiagnostic,
	netcraftSubmissionUrl,
	netcraftSubmissionUrlsUrl,
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

	test("extracts only a validated receipt ID from raw or escaped diagnostics", () => {
		const opaque = "lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV";
		expect(netcraftSubmissionIdFromDiagnostic(`Netcraft response: {"message":"Successfully reported","uuid":"${opaque}"}`)).toBe(opaque);
		expect(netcraftSubmissionIdFromDiagnostic(`serialized error: {\\"uuid\\":\\"${opaque}\\"}`)).toBe(opaque);
		expect(netcraftSubmissionIdFromDiagnostic('response: {"uuid":"https://attacker.example/"}')).toBeUndefined();
		expect(netcraftSubmissionIdFromDiagnostic('response: {"message":"accepted"}')).toBeUndefined();
	});

	test("reads a bounded submission status and URL list without making a write request", async () => {
		const opaque = "lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV";
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const result = await fetchNetcraftSubmissionStatus({
			uuid: opaque,
			fetch: async (url, init) => {
				requests.push({ url: String(url), init });
				if (String(url) === netcraftSubmissionUrl(opaque)) {
					return new Response(JSON.stringify({
						state: "processing",
						pending: 0,
						has_urls: 1,
						last_update: 1_788_177_992,
					}));
				}
				if (String(url) === netcraftSubmissionUrlsUrl(opaque)) {
					return new Response(JSON.stringify({
						filtered_count: 1,
						total_count: 1,
						urls: [{ url: "https://shop.hd-media.space/", url_state: "processing" }],
					}));
				}
				return new Response("unexpected URL", { status: 500 });
			},
		});

		expect(result).toEqual({
			uuid: opaque,
			state: "processing",
			pending: false,
			hasUrls: true,
			lastUpdate: 1_788_177_992,
			urls: [{ url: "https://shop.hd-media.space/", state: "processing" }],
		});
		expect(requests).toHaveLength(2);
		expect(requests.every(({ init }) => init?.method === "GET" && init?.redirect === "error")).toBeTrue();
	});

	test("fails closed when a status response is malformed or its URL list is empty", async () => {
		const opaque = "lFQ9vJzdwxWau2LTPeu665VWSCpxiFGV";
		await expect(fetchNetcraftSubmissionStatus({
			uuid: opaque,
			fetch: async () => new Response(JSON.stringify({ state: "processing", pending: 0, has_urls: 1 })),
		})).rejects.toThrow("submission-URLs response did not match");
		await expect(fetchNetcraftSubmissionStatus({
			uuid: opaque,
			fetch: async () => new Response("not json"),
		})).rejects.toThrow("submission-status request returned malformed JSON");
		await expect(fetchNetcraftSubmissionStatus({
			uuid: opaque,
			fetch: async () => new Response(JSON.stringify({ state: "processing", pending: 0, has_urls: 1, uuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })),
		})).rejects.toThrow("submission-status response did not match");
		await expect(fetchNetcraftSubmissionStatus({
			uuid: opaque,
			fetch: async () => new Response(JSON.stringify({ state: "processing", pending: 0, has_urls: 1, warnings: ["provider warning"] })),
		})).rejects.toThrow("submission-status response did not match");
	});
});

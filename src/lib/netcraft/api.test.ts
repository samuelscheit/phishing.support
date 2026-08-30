import { describe, expect, test } from "bun:test";

import { netcraftSubmissionUrl, parseNetcraftSubmissionResponse } from "./api";

describe("Netcraft submission receipt parsing", () => {
	test("accepts both compact and RFC 4122 UUID serializations documented by the provider", async () => {
		const compact = "AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
		const hyphenated = "123E4567-E89B-12D3-A456-426614174000";

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
	});

	test("keeps an unconfirmed successful response ambiguous but preserves bounded provider diagnostics", async () => {
		await expect(parseNetcraftSubmissionResponse(
			new Response(JSON.stringify({ message: "Accepted without an identifier", status: "accepted" })),
		)).rejects.toThrow('Netcraft report did not include a valid submission UUID: {"message":"Accepted without an identifier","status":"accepted"}');
	});

	test("rejects values that are not compact or RFC 4122 UUIDs", () => {
		expect(() => netcraftSubmissionUrl("https://attacker.example/")).toThrow("invalid submission UUID");
		expect(() => netcraftSubmissionUrl("123e4567-e89b-12d3-a456-42661417400z")).toThrow("invalid submission UUID");
	});
});

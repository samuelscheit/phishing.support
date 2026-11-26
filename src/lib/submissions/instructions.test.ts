import { describe, expect, test } from "bun:test";

import { MAX_REPORTER_INSTRUCTION_CHARS, parseReporterInstructions } from "./instructions";

describe("the reporter's instructions of a submission", () => {
	test("are optional: absent, null or an empty object leave none", () => {
		expect(parseReporterInstructions(undefined)).toEqual({ ok: true });
		expect(parseReporterInstructions(null)).toEqual({ ok: true });
		expect(parseReporterInstructions({})).toEqual({ ok: true });
		expect(parseReporterInstructions({ browser: null, analysis: undefined })).toEqual({ ok: true });
	});

	test("are trimmed, and a blank field is dropped", () => {
		expect(parseReporterInstructions({ browser: "  Click 'Download PDF'.\n", analysis: " \n\t " })).toEqual({ ok: true, instructions: { browser: "Click 'Download PDF'." } });
		expect(parseReporterInstructions({ browser: "", analysis: "  It impersonates Example Bank. " })).toEqual({ ok: true, instructions: { analysis: "It impersonates Example Bank." } });
		expect(parseReporterInstructions({ browser: "   ", analysis: "" })).toEqual({ ok: true });
	});

	test("keep inner whitespace and markup as plain text, and ignore unknown keys", () => {
		expect(parseReporterInstructions({ browser: "Line 1\n\nLine 2 <b>x</b>", extra: "dropped" })).toEqual({ ok: true, instructions: { browser: "Line 1\n\nLine 2 <b>x</b>" } });
	});

	test("take up to 2,000 characters after trimming and reject more", () => {
		const max = "a".repeat(MAX_REPORTER_INSTRUCTION_CHARS);
		expect(parseReporterInstructions({ browser: `  ${max}  ` })).toEqual({ ok: true, instructions: { browser: max } });
		expect(parseReporterInstructions({ analysis: `${max}b` })).toEqual({ ok: false, error: "instructions.analysis is longer than 2000 characters" });
		expect(parseReporterInstructions({ browser: "ok", analysis: `${max}b` }).ok).toBeFalse();
	});

	test("reject anything but an object of text", () => {
		for (const value of ["click it", 42, true, ["click it"]]) {
			expect(parseReporterInstructions(value)).toEqual({ ok: false, error: "instructions must be an object with optional browser and analysis text" });
		}
		expect(parseReporterInstructions({ browser: 42 })).toEqual({ ok: false, error: "instructions.browser must be text" });
		expect(parseReporterInstructions({ analysis: ["x"] })).toEqual({ ok: false, error: "instructions.analysis must be text" });
		expect(parseReporterInstructions({ analysis: { text: "x" } })).toEqual({ ok: false, error: "instructions.analysis must be text" });
	});
});

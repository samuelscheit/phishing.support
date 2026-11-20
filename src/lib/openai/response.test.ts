import { expect, test } from "bun:test";

import { extractResponseOutputText, responseContentParts } from "./response";

const message = (...content: object[]) => ({ type: "message", content });

test("responseContentParts reads only assistant message content", () => {
	const output = [{ type: "reasoning", content: [{ type: "output_text", text: "hidden" }] }, message({ type: "output_text", text: "a" }), message({ type: "refusal", refusal: "no" })];
	expect(responseContentParts(output)).toEqual([
		{ type: "output_text", text: "a" },
		{ type: "refusal", refusal: "no" },
	]);
	expect(responseContentParts(undefined)).toEqual([]);
});

test("extractResponseOutputText joins message text and falls back to output_text", () => {
	expect(extractResponseOutputText({ output: [message({ type: "output_text", text: "a" }, { type: "output_text", text: "b" })] })).toBe("ab");
	expect(extractResponseOutputText({ output: [], output_text: "fallback" })).toBe("fallback");
	expect(extractResponseOutputText({})).toBe("");
});

test("extractResponseOutputText throws on refusals and unknown parts", () => {
	expect(() => extractResponseOutputText({ output: [message({ type: "refusal", refusal: "no" })] })).toThrow("Model refused to answer: no");
	expect(() => extractResponseOutputText({ output: [message({ type: "image" })] })).toThrow("Unknown output content type");
});

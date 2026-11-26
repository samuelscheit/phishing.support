import { describe, expect, test } from "bun:test";

import { LIVE_INPUT } from "@/lib/site_visit/live_input";
import { keyInput, keyPress, MAX_TEXT, MODIFIER, textInputs, type KeyLike } from "./keys";

const key = (overrides: Partial<KeyLike>): KeyLike => ({ key: "a", code: "KeyA", keyCode: 65, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...overrides });

describe("keyInput", () => {
	test("forwards printable keys down and up, valid for the endpoint", () => {
		const down = keyInput(key({}), "down");
		expect(down).toEqual({ type: "key", phase: "down", key: "a", code: "KeyA", keyCode: 65, modifiers: 0 });
		expect(LIVE_INPUT.parse(down)).toEqual(down!);
		expect(keyInput(key({}), "up")?.phase).toBe("up");
		expect(keyInput(key({ key: " ", code: "Space", keyCode: 32 }), "down")?.key).toBe(" ");
		expect(keyInput(key({ key: "ü", code: "BracketLeft", keyCode: 186 }), "down")?.key).toBe("ü");
	});

	test("a printable character outside the BMP counts as one key", () => {
		expect(keyInput(key({ key: "😀", code: "", keyCode: 0 }), "down")?.key).toBe("😀");
	});

	test("carries Shift and Alt in the modifier bit field", () => {
		expect(keyInput(key({ key: "A", shiftKey: true }), "down")?.modifiers).toBe(MODIFIER.shift);
		expect(keyInput(key({ key: "å", altKey: true }), "down")?.modifiers).toBe(MODIFIER.alt);
		expect(keyInput(key({ key: "Tab", code: "Tab", keyCode: 9, shiftKey: true }), "down")?.modifiers).toBe(MODIFIER.shift);
	});

	test("forwards the editing and navigation keys", () => {
		for (const name of ["Enter", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]) {
			expect(keyInput(key({ key: name, code: name }), "down")?.key).toBe(name);
		}
	});

	test("keeps Escape, function keys and lone modifiers local", () => {
		for (const name of ["Escape", "F5", "F12", "Shift", "Control", "Meta", "Alt", "CapsLock", "ContextMenu"]) {
			expect(keyInput(key({ key: name, code: name }), "down")).toBeUndefined();
		}
	});

	test("forwards only Ctrl/Cmd+A of the shortcuts", () => {
		expect(keyInput(key({ ctrlKey: true }), "down")?.modifiers).toBe(MODIFIER.ctrl);
		expect(keyInput(key({ metaKey: true }), "down")?.modifiers).toBe(MODIFIER.meta);
		expect(keyInput(key({ key: "A", metaKey: true, shiftKey: true }), "down")?.modifiers).toBe(MODIFIER.meta | MODIFIER.shift);
		for (const letter of ["c", "v", "x", "z", "r", "t", "w", "l"]) {
			expect(keyInput(key({ key: letter, ctrlKey: true }), "down")).toBeUndefined();
			expect(keyInput(key({ key: letter, metaKey: true }), "down")).toBeUndefined();
		}
		expect(keyInput(key({ key: "Backspace", metaKey: true }), "down")).toBeUndefined();
		expect(keyInput(key({ key: "ArrowLeft", ctrlKey: true }), "down")).toBeUndefined();
	});

	test("AltGr (Ctrl+Alt) characters are plain text", () => {
		expect(keyInput(key({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true }), "down")?.modifiers).toBe(0);
		expect(keyInput(key({ key: "€", code: "KeyE", ctrlKey: true, altKey: true, shiftKey: true }), "down")?.modifiers).toBe(MODIFIER.shift);
		expect(keyInput(key({ key: "a", ctrlKey: true, altKey: true }), "down")?.modifiers).toBe(MODIFIER.ctrl | MODIFIER.alt);
	});

	test("ignores input method composition", () => {
		expect(keyInput(key({ isComposing: true }), "down")).toBeUndefined();
		expect(keyInput(key({ key: "Process", keyCode: 229 }), "down")).toBeUndefined();
		expect(keyInput(key({ key: "Unidentified", keyCode: 229 }), "down")).toBeUndefined();
		expect(keyInput(key({ key: "a", keyCode: 229 }), "down")).toBeUndefined();
		expect(keyInput(key({ key: "Dead", code: "Quote" }), "down")).toBeUndefined();
	});

	test("bounds the code and key code to what the endpoint accepts", () => {
		const input = keyInput(key({ code: "X".repeat(40), keyCode: 999 }), "down")!;
		expect(input.code).toHaveLength(32);
		expect(input.keyCode).toBe(255);
		expect(LIVE_INPUT.safeParse(input).success).toBe(true);
		expect(keyInput(key({ keyCode: Number.NaN }), "down")?.keyCode).toBe(0);
	});
});

describe("keyPress", () => {
	test("a soft keyboard's Backspace and Enter press and release", () => {
		expect(keyPress("Backspace").map((input) => [input.phase, input.key, input.keyCode])).toEqual([["down", "Backspace", 8], ["up", "Backspace", 8]]);
		expect(keyPress("Enter").every((input) => LIVE_INPUT.safeParse(input).success)).toBe(true);
	});
});

describe("textInputs", () => {
	test("short text is one input", () => {
		expect(textInputs("hello")).toEqual([{ type: "text", text: "hello" }]);
		expect(textInputs("")).toEqual([]);
	});

	test("normalises line breaks", () => {
		expect(textInputs("a\r\nb\rc")).toEqual([{ type: "text", text: "a\nb\nc" }]);
	});

	test("splits long text without splitting a character", () => {
		const text = `${"x".repeat(MAX_TEXT - 1)}😀${"y".repeat(10)}`;
		const inputs = textInputs(text);
		expect(inputs).toHaveLength(2);
		expect(inputs[0]!.text.endsWith("😀")).toBe(true);
		expect(inputs.map((input) => input.text).join("")).toBe(text);
		expect(inputs.every((input) => LIVE_INPUT.safeParse(input).success)).toBe(true);
	});
});

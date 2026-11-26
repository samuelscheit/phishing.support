import type { LiveInput } from "@/lib/site_visit/live_input";

/**
 * Which local keys a driver's page gets. Typing and editing keys go to the
 * page; the viewer's own shortcuts (copy, new tab, reload, …) stay with the
 * viewer's browser, except select-all. Escape leaves the console and never
 * reaches the page. Keys of an input method's composition are skipped: its
 * text comes as `text` once composed.
 */

export type KeyInput = Extract<LiveInput, { type: "key" }>;
export type TextInput = Extract<LiveInput, { type: "text" }>;

export type KeyLike = {
	key: string;
	code: string;
	keyCode: number;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
	isComposing: boolean;
};

export const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** The named keys a page gets besides printable ones. */
const NAMED_KEYS = new Set(["Enter", "Tab", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
/** What a key reports while an input method composes, or for a key it does not know. */
const COMPOSING_KEYS = new Set(["Process", "Unidentified", "Dead"]);
/** The key code browsers report for any key an input method handles. */
const IME_KEY_CODE = 229;
const MAX_KEY = 32;
/** Characters of one `text` input at most. */
export const MAX_TEXT = 2_000;

const printable = (key: string) => [...key].length === 1;

/** The page's key event for a local one, or nothing when the key stays local. */
export function keyInput(event: KeyLike, phase: "down" | "up"): KeyInput | undefined {
	const { key } = event;
	if (event.isComposing || event.keyCode === IME_KEY_CODE || COMPOSING_KEYS.has(key) || key === "Escape" || !key || key.length > MAX_KEY) return undefined;
	// AltGr on Windows and Linux reports Ctrl+Alt: the character it typed is plain text.
	const altGraph = event.ctrlKey && event.altKey && !event.metaKey && printable(key) && key.toLowerCase() !== "a";
	const ctrl = event.ctrlKey && !altGraph;
	const alt = event.altKey && !altGraph;
	if ((ctrl || event.metaKey) && key.toLowerCase() !== "a") return undefined;
	if (!printable(key) && !NAMED_KEYS.has(key)) return undefined;
	const modifiers = (alt ? MODIFIER.alt : 0) | (ctrl ? MODIFIER.ctrl : 0) | (event.metaKey ? MODIFIER.meta : 0) | (event.shiftKey ? MODIFIER.shift : 0);
	return { type: "key", phase, key, code: event.code.slice(0, MAX_KEY), keyCode: Math.min(255, Math.max(0, Math.trunc(event.keyCode) || 0)), modifiers };
}

/** A key pressed and released, for keys a soft keyboard sends without key events (Backspace, Enter). */
export function keyPress(key: "Backspace" | "Enter"): KeyInput[] {
	const keyCode = key === "Enter" ? 13 : 8;
	return (["down", "up"] as const).map((phase) => ({ type: "key", phase, key, code: key, keyCode, modifiers: 0 }));
}

/** Text to type, split into inputs the page accepts; never splitting a character. */
export function textInputs(text: string): TextInput[] {
	const characters = [...text.replace(/\r\n?/g, "\n")];
	const inputs: TextInput[] = [];
	for (let index = 0; index < characters.length; index += MAX_TEXT) inputs.push({ type: "text", text: characters.slice(index, index + MAX_TEXT).join("") });
	return inputs;
}

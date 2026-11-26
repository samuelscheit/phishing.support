import type { CDPSession } from "rebrowser-puppeteer-core";
import { z } from "zod";

import { SYNTHETIC_FIELDS } from "./visit_task";

/**
 * What a person driving a live visit sends: pointer, wheel and key events in
 * the page's CSS pixels, typed or pasted text, and the browser controls a
 * visitor has (back, forward, reload, switching tabs). There is no address
 * bar: a person moves only through the site itself, like the agent.
 */

const coordinate = z.number().finite().min(0).max(20_000);
const delta = z.number().finite().min(-10_000).max(10_000);

export const LIVE_INPUT = z.discriminatedUnion("type", [
	z.object({ type: z.literal("pointer"), phase: z.enum(["down", "move", "up"]), x: coordinate, y: coordinate, button: z.enum(["left", "middle", "right"]).default("left"), clickCount: z.number().int().min(1).max(3).default(1) }),
	z.object({ type: z.literal("wheel"), x: coordinate, y: coordinate, deltaX: delta, deltaY: delta }),
	z.object({
		type: z.literal("key"),
		phase: z.enum(["down", "up"]),
		key: z.string().min(1).max(32),
		code: z.string().max(32).default(""),
		keyCode: z.number().int().min(0).max(255).default(0),
		/** Bit field: Alt 1, Ctrl 2, Meta 4, Shift 8. */
		modifiers: z.number().int().min(0).max(15).default(0),
	}),
	z.object({ type: z.literal("text"), text: z.string().min(1).max(2_000) }),
	z.object({ type: z.literal("fake"), field: z.enum(SYNTHETIC_FIELDS) }),
	z.object({ type: z.literal("history"), direction: z.enum(["back", "forward"]) }),
	z.object({ type: z.literal("reload") }),
	z.object({ type: z.literal("tab"), targetId: z.string().min(1).max(64) }),
	z.object({ type: z.literal("capture") }),
]);

export type LiveInput = z.infer<typeof LIVE_INPUT>;
/** The inputs that go to the page as the browser's own input events. */
export type PageInput = Extract<LiveInput, { type: "pointer" | "wheel" | "key" | "text" }>;

export const ALT = 1;
export const CTRL = 2;
export const META = 4;
export const SHIFT = 8;

/** The editing shortcuts a driver may use; any other Ctrl or Cmd combination never reaches the page. */
const EDITING_COMMANDS: Record<string, string> = { a: "selectAll", z: "undo", y: "redo", x: "cut", c: "copy" };

/** Whether a key event may reach the page: plain keys, and only the editing shortcuts with Ctrl or Cmd. */
export function keyAllowed(key: string, modifiers: number): boolean {
	return !(modifiers & (CTRL | META)) || Object.hasOwn(EDITING_COMMANDS, key.toLowerCase());
}

/** Keys that put text into the page, and the text Chrome expects with them. */
function keyText(key: string, modifiers: number): string | undefined {
	if (modifiers & (CTRL | META)) return undefined;
	if (key === "Enter") return "\r";
	return [...key].length === 1 ? key : undefined;
}

/** Editing commands Chrome runs only when the key event names them (a headless key event has no menu). */
function keyCommands(key: string, modifiers: number): string[] {
	if (!(modifiers & (CTRL | META))) return [];
	const lower = key.toLowerCase();
	const command = lower === "z" && modifiers & SHIFT ? "redo" : EDITING_COMMANDS[lower];
	return command ? [command] : [];
}

const BUTTON_MASK = { left: 1, right: 2, middle: 4 } as const;

/** A tab's input channel: its CDP session, and whether it emulates a touch screen (a phone capture). */
export type InputTab = { session: CDPSession; touch: boolean };

/** Which pointer button is held, and where, across the events of one press. */
export type PointerState = { pressed?: "left" | "middle" | "right"; x?: number; y?: number };

/** Send one input to the tab as the browser's own (trusted) input events. */
export async function dispatchPageInput(tab: InputTab, input: PageInput, state: PointerState): Promise<void> {
	const { session } = tab;
	switch (input.type) {
		case "pointer": {
			const { x, y, phase } = input;
			if (tab.touch) {
				if (phase !== "down" && !state.pressed) return;
				Object.assign(state, { pressed: phase === "up" ? undefined : input.button, x, y });
				await session.send("Input.dispatchTouchEvent", { type: phase === "down" ? "touchStart" : phase === "move" ? "touchMove" : "touchEnd", touchPoints: phase === "up" ? [] : [{ x, y }] });
				return;
			}
			if (phase === "move") {
				Object.assign(state, { x, y });
				await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: state.pressed ?? "none", buttons: state.pressed ? BUTTON_MASK[state.pressed] : 0 });
				return;
			}
			if (phase === "down") {
				await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
				Object.assign(state, { pressed: input.button, x, y });
			} else {
				Object.assign(state, { pressed: undefined, x, y });
			}
			await session.send("Input.dispatchMouseEvent", { type: phase === "down" ? "mousePressed" : "mouseReleased", x, y, button: input.button, buttons: phase === "down" ? BUTTON_MASK[input.button] : 0, clickCount: input.clickCount });
			return;
		}
		case "wheel":
			await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY });
			return;
		case "key": {
			if (!keyAllowed(input.key, input.modifiers)) return;
			const text = input.phase === "down" ? keyText(input.key, input.modifiers) : undefined;
			const commands = input.phase === "down" ? keyCommands(input.key, input.modifiers) : [];
			await session.send("Input.dispatchKeyEvent", {
				type: input.phase === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
				key: input.key,
				code: input.code,
				windowsVirtualKeyCode: input.keyCode,
				nativeVirtualKeyCode: input.keyCode,
				modifiers: input.modifiers,
				...(text ? { text, unmodifiedText: text } : {}),
				...(commands.length ? { commands } : {}),
			});
			return;
		}
		case "text":
			await session.send("Input.insertText", { text: input.text });
			return;
	}
}

/** Let go of a button or finger still held, as a driver's turn ends mid-press. */
export async function releasePointer(tab: InputTab, state: PointerState): Promise<void> {
	const pressed = state.pressed;
	if (!pressed) return;
	state.pressed = undefined;
	const at = { x: state.x ?? 0, y: state.y ?? 0 };
	await (tab.touch
		? tab.session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
		: tab.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: pressed, buttons: 0, clickCount: 1 })).catch(() => undefined);
}

const MAX_LABEL = 80;

/**
 * The element under a point, as the record names it: its tag with id, name
 * and type, and what it says (its label, placeholder or text), for example
 * `input#email[name=email][type=email] "Email address"`. Read from the
 * browser's DOM agent, never from the page's own scripts.
 */
export async function describeElementAt(session: CDPSession, x: number, y: number): Promise<string | undefined> {
	try {
		await session.send("DOM.getDocument", { depth: 0 });
		// The point is in the viewport; the DOM agent finds nodes by document coordinates.
		const { cssVisualViewport } = await session.send("Page.getLayoutMetrics");
		const { backendNodeId } = await session.send("DOM.getNodeForLocation", { x: Math.round(x + cssVisualViewport.pageX), y: Math.round(y + cssVisualViewport.pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false });
		return elementDescription((await session.send("DOM.describeNode", { backendNodeId, depth: 1 })).node);
	} catch {
		return undefined;
	}
}

/** The element that has the keyboard focus (what typed text goes into), described as `describeElementAt` does. */
export async function describeFocusedElement(session: CDPSession): Promise<string | undefined> {
	let objectId: string | undefined;
	try {
		({ result: { objectId } } = await session.send("Runtime.evaluate", { expression: "document.activeElement", returnByValue: false }));
		if (!objectId) return undefined;
		const { node } = await session.send("DOM.describeNode", { objectId, depth: 1 });
		return node.localName === "body" ? undefined : elementDescription(node);
	} catch {
		return undefined;
	} finally {
		if (objectId) await session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
	}
}

type DescribedNode = { nodeName: string; localName: string; attributes?: string[]; children?: Array<{ nodeType: number; nodeValue: string }> };

function elementDescription(node: DescribedNode): string {
	const attributes = new Map<string, string>();
	for (let index = 0; index + 1 < (node.attributes ?? []).length; index += 2) attributes.set(node.attributes![index]!, node.attributes![index + 1]!);
	const tag = node.localName || node.nodeName.toLowerCase();
	const id = attributes.get("id");
	const qualifiers = ["name", "type", "role"].flatMap((name) => (attributes.get(name) ? [`[${name}=${attributes.get(name)}]`] : [])).join("");
	const ownText = (node.children ?? []).filter((child) => child.nodeType === 3).map((child) => child.nodeValue).join(" ");
	const label = [attributes.get("aria-label"), attributes.get("placeholder"), attributes.get("title"), attributes.get("alt"), ownText, tag === "input" && ["submit", "button"].includes(attributes.get("type") ?? "") ? attributes.get("value") : undefined]
		.map((value) => value?.replace(/\s+/g, " ").trim())
		.find(Boolean);
	return `${tag}${id ? `#${id}` : ""}${qualifiers}${label ? ` ${JSON.stringify(label.slice(0, MAX_LABEL))}` : ""}`;
}

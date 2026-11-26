import type { CDPSession } from "rebrowser-puppeteer-core";

import { sendBeforeRun } from "./cdp";

/**
 * What the pages of a visit put on the visitor's clipboard. A ClickFix kit
 * shows a harmless command (`brew install --cask levo`, trylevo.app,
 * production case 384401854580134038) while its Copy button writes another
 * one that fetches and runs a payload; only the write itself shows what a
 * victim pastes.
 *
 * Every document of a tab, its frames' too, runs hooks before its own
 * scripts: `navigator.clipboard.writeText` and `write`, a copy or cut event
 * whose handler sets the copied text, and `document.execCommand("copy")`
 * copying the selection. Each hook calls the page's own API unchanged, so the
 * copy succeeds or fails as it would. The hooks hand each write to a listener
 * in an isolated world of the same document (a DOM event of a random type),
 * which reports it through a CDP binding that exists only in that world: the
 * page sees no global of ours. Chrome adds a binding to a new document's
 * world only with the Runtime domain enabled, which pages can detect, so the
 * world and its binding are made for each document as it commits; the hooks
 * keep what was written before that and hand it over once the listener asks.
 */

/** How the page wrote: `copy_event` is a copy or cut handler setting the text, `exec_command` the selection `execCommand("copy")` copied. */
export type ClipboardWriteMethod = "writeText" | "write" | "copy_event" | "exec_command";

/** A text a page put on the clipboard; a write the browser refused (no focus or permission) is still what the page meant to copy. */
export type ClipboardWrite = {
	text: string;
	/** The document that wrote it: the page, or a frame on it. */
	documentUrl: string;
	via: ClipboardWriteMethod;
	/** When the write was reported, ISO 8601. */
	at: string;
};

/** Characters kept of one write; a command fits many times over. */
export const MAX_CLIPBOARD_WRITE_CHARACTERS = 16_000;
/** Writes kept per visit; a page copying in a loop cannot grow the record. */
export const MAX_CLIPBOARD_WRITES = 50;

const METHODS = new Set<ClipboardWriteMethod>(["writeText", "write", "copy_event", "exec_command"]);

/**
 * The hooks, run in the page's main world of every document before its
 * scripts. Self-contained: it is sent to the browser as source.
 */
function hookClipboardWrites(eventType: string, readyType: string, maxCharacters: number): void {
	// The page's own globals may be replaced later; the hooks use the originals.
	const dispatch = EventTarget.prototype.dispatchEvent;
	const listen = EventTarget.prototype.addEventListener;
	const Custom = CustomEvent;
	const stringify = JSON.stringify;
	const later = setTimeout;
	const apply = Reflect.apply;
	const selectionOf = getSelection;
	const doc = document;
	const queued: string[] = [];
	// The listener cancels each event it takes; one not taken waits for it.
	const deliver = (detail: string) => apply(dispatch, doc, [new Custom(eventType, { detail, cancelable: true })]) === false;
	const report = (text: unknown, via: string) => {
		if (typeof text !== "string" || !text) return;
		const detail = stringify({ text: text.slice(0, maxCharacters), via });
		if (!deliver(detail)) queued.push(detail);
	};
	// The listener asks once it exists; the answer (the event canceled) tells it the hooks are there.
	apply(listen, doc, [readyType, (event: Event) => {
		event.preventDefault();
		while (queued.length && deliver(queued[0]!)) queued.shift();
	}, true]);
	/** The native source each hook shows: a proxy's own reads "function () { [native code] }", without the name. */
	const nativeSource = new WeakMap<object, string>();
	const toSource = Function.prototype.toString;
	/** Replace a method with a proxy of itself: same name, length, descriptor and native source, the original's behavior. */
	const hook = (owner: object | undefined, name: string, around: (original: (...args: unknown[]) => unknown, self: unknown, args: unknown[]) => unknown) => {
		const original = owner ? (owner as Record<string, unknown>)[name] : undefined;
		if (typeof original !== "function") return;
		const proxy = new Proxy(original, { apply: (target, self, args) => around(target as (...args: unknown[]) => unknown, self, args) });
		nativeSource.set(proxy, apply(toSource, original, []) as string);
		(owner as Record<string, unknown>)[name] = proxy;
	};
	hook(Function.prototype, "toString", (original, self, args) => (nativeSource.has(self as object) ? nativeSource.get(self as object) : apply(original, self, args)));
	const clipboard = typeof Clipboard === "function" ? Clipboard.prototype : undefined;
	hook(clipboard, "writeText", (original, self, args) => {
		// Only a string is read here: converting another value would run the page's code twice.
		report(args[0], "writeText");
		return apply(original, self, args);
	});
	const getType = typeof ClipboardItem === "function" ? ClipboardItem.prototype.getType : undefined;
	const blobText = Blob.prototype.text;
	hook(clipboard, "write", (original, self, args) => {
		try {
			const items = args[0];
			if (getType && Array.isArray(items)) {
				for (const item of items) {
					if (!(item instanceof ClipboardItem) || !item.types.includes("text/plain")) continue;
					(apply(getType, item, ["text/plain"]) as Promise<Blob>)
						.then((blob) => apply(blobText, blob, []) as Promise<string>)
						.then((text) => report(text, "write"), () => undefined);
				}
			}
		} catch {
			// The page's write goes ahead whatever its items are.
		}
		return apply(original, self, args);
	});
	/** The copy or cut event being dispatched, and the text its handlers set. */
	let copying: { data: DataTransfer | null; set?: string } | undefined;
	let execCopy = false;
	const selectedText = (): string => {
		const active = doc.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
		if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT") && typeof active.selectionStart === "number") {
			return active.value.slice(active.selectionStart, active.selectionEnd ?? active.selectionStart);
		}
		return selectionOf()?.toString() ?? "";
	};
	const onCopy = (event: Event) => {
		const state: { data: DataTransfer | null; set?: string } = { data: (event as ClipboardEvent).clipboardData };
		const exec = execCopy;
		// execCommand copies what is selected when the event starts, unless a handler sets the text instead.
		const selection = exec ? selectedText() : "";
		copying = state;
		// After every handler ran: a set text counts only when the default copy was prevented.
		apply(later, window, [() => {
			if (copying === state) copying = undefined;
			if (state.set !== undefined && event.defaultPrevented) report(state.set, "copy_event");
			else if (exec) report(selection, "exec_command");
		}, 0]);
	};
	// Registered before any page script: they run first.
	apply(listen, window, ["copy", onCopy, true]);
	apply(listen, window, ["cut", onCopy, true]);
	hook(typeof DataTransfer === "function" ? DataTransfer.prototype : undefined, "setData", (original, self, args) => {
		if (copying && self === copying.data && /^text(?:\/plain)?$/i.test(String(args[0]))) copying.set = String(args[1]);
		return apply(original, self, args);
	});
	hook(Document.prototype, "execCommand", (original, self, args) => {
		if (!/^(?:copy|cut)$/i.test(String(args[0]))) return apply(original, self, args);
		execCopy = true;
		try {
			return apply(original, self, args);
		} finally {
			execCopy = false;
		}
	});
}

/**
 * The listener, run in an isolated world of one document: it takes each
 * write the hooks hand over and reports it with the document's address.
 * Returns whether the document has the hooks. Self-contained: it is sent to
 * the browser as source.
 */
function forwardClipboardWrites(bindingName: string, eventType: string, readyType: string): boolean {
	const report = (globalThis as unknown as Record<string, (payload: string) => void>)[bindingName]!;
	document.addEventListener(eventType, (event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		const { text, via } = JSON.parse(String((event as CustomEvent).detail)) as { text: string; via: string };
		report(JSON.stringify({ text, via, documentUrl: location.href }));
	}, true);
	// Ask for what was written before the listener existed.
	return !document.dispatchEvent(new CustomEvent(readyType, { cancelable: true }));
}

const randomName = () => `${String.fromCharCode(97 + Math.floor(Math.random() * 26))}${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`;
const source = (fn: (...args: never[]) => void, ...args: unknown[]) => `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(", ")});`;

type FrameTargetAttached = { sessionId: string; waitingForDebugger: boolean; targetInfo: { type: string } };

/** The clipboard writes of every tab and frame it is attached to, in the order they were reported. */
export class ClipboardRecorder {
	readonly #writes: ClipboardWrite[] = [];
	readonly #binding = randomName();
	readonly #world = randomName();
	readonly #eventType = randomName();
	readonly #readyType = randomName();

	writes(): ClipboardWrite[] {
		return [...this.#writes];
	}

	/**
	 * Record a tab from its next document on, and every frame of it in
	 * another process (each its own target). A held tab (`held`: one waiting
	 * for the debugger before its first request) only answers once it runs,
	 * so its setup is sent without waiting; a running tab's is applied before
	 * this resolves.
	 */
	async attach(session: CDPSession, { held = false }: { held?: boolean } = {}): Promise<void> {
		const listened = new Set<string>();
		session.on("Runtime.bindingCalled", (event: { name: string; payload: string }) => {
			if (event.name === this.#binding) this.#record(event.payload);
		});
		session.on("Page.frameNavigated", ({ frame }: { frame: { id: string; loaderId: string; parentId?: string } }) => {
			const document = `${frame.id} ${frame.loaderId}`;
			if (listened.has(document)) return;
			listened.add(document);
			void this.#listen(session, frame.id, !frame.parentId);
		});
		session.on("Target.attachedToTarget", (event: FrameTargetAttached) => {
			void this.#attachFrame(session, event);
		});
		const applied = [
			sendBeforeRun(session, "Page.enable"),
			sendBeforeRun(session, "Page.addScriptToEvaluateOnNewDocument", { source: this.#hooks() }),
		];
		// The browser answers this one at once, also for a held tab.
		await session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe", exclude: false }] });
		if (!held) await Promise.all(applied);
	}

	/** A frame in another process, held until its hooks are set up. */
	async #attachFrame(parent: CDPSession, event: FrameTargetAttached): Promise<void> {
		const session = parent.connection()?.session(event.sessionId);
		if (!session) return;
		try {
			if (event.targetInfo.type === "iframe") await this.attach(session, { held: event.waitingForDebugger });
		} finally {
			if (event.waitingForDebugger) void sendBeforeRun(session, "Runtime.runIfWaitingForDebugger");
		}
	}

	#hooks(): string {
		return source(hookClipboardWrites, this.#eventType, this.#readyType, MAX_CLIPBOARD_WRITE_CHARACTERS);
	}

	/**
	 * The listener for the document a frame just committed. The first
	 * document of a tab a page opened (window.open) can start before the
	 * hooks were registered and runs without them: its main frame is given
	 * them now, after its first scripts.
	 */
	async #listen(session: CDPSession, frameId: string, mainFrame: boolean): Promise<void> {
		try {
			const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId, worldName: this.#world });
			await session.send("Runtime.addBinding", { name: this.#binding, executionContextId });
			const { result } = await session.send("Runtime.evaluate", { expression: source(forwardClipboardWrites, this.#binding, this.#eventType, this.#readyType), contextId: executionContextId, returnByValue: true });
			// Without a context id, the main world of the main frame.
			if (result.value === false && mainFrame) await session.send("Runtime.evaluate", { expression: this.#hooks() });
		} catch {
			// A document gone before its listener arrived wrote nothing it could still report.
		}
	}

	#record(payload: string): void {
		if (this.#writes.length >= MAX_CLIPBOARD_WRITES) return;
		let write: Partial<Record<keyof ClipboardWrite, unknown>>;
		try {
			write = JSON.parse(payload) as typeof write;
		} catch {
			return;
		}
		const { text, via, documentUrl } = write;
		if (typeof text !== "string" || !text || typeof documentUrl !== "string" || !METHODS.has(via as ClipboardWriteMethod)) return;
		this.#writes.push({ text: text.slice(0, MAX_CLIPBOARD_WRITE_CHARACTERS), documentUrl, via: via as ClipboardWriteMethod, at: new Date().toISOString() });
	}
}

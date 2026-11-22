import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpConnection } from "browser-fabric/packages/worker-runtime/src/cdp-connection";

/** A file the agent may attach to a file input: its bytes live in this process, not on the browser's machine. */
export type BrowserTaskFile = { filename: string; mimeType: string; bytes: Buffer };

/** The page-side setter gets the bytes over CDP; a large screenshot needs more than the default command timeout. */
const SET_FILES_TIMEOUT_MS = 60_000;

/**
 * Files staged for one task. The task agent's `upload` tool accepts only real
 * paths inside its allowed upload directories and then asks the browser, with
 * `DOM.setFileInputFiles`, to read them from disk: for the input it was given
 * (`objectId`), or for the input of the file chooser its click on an "Add
 * file" control or drop area opened (`backendNodeId`). A Fabric browser runs
 * on another machine, where those paths do not exist. So the files are staged
 * in a private directory here (for the agent's path policy), and the
 * connection the agent drives answers `DOM.setFileInputFiles` itself: it sets
 * exactly the staged bytes on that input in the page, as a user's file choice
 * would.
 */
export type StagedUploads = {
	directory: string;
	connection(endpoint: string): Promise<CdpConnection>;
	dispose(): Promise<void>;
};

const OBJECT_GROUP = "browser-task-uploads";

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function stageUploads(files: readonly BrowserTaskFile[]): Promise<StagedUploads> {
	if (files.length === 0) throw new Error("No files to stage for upload.");
	const names = new Set<string>();
	for (const file of files) {
		if (!SAFE_FILENAME.test(file.filename) || file.filename.includes("..")) throw new Error(`Upload filename ${JSON.stringify(file.filename)} is not a plain file name.`);
		if (names.has(file.filename)) throw new Error(`Upload filename ${file.filename} is staged twice.`);
		if (!Buffer.isBuffer(file.bytes) || file.bytes.byteLength === 0) throw new Error(`Upload file ${file.filename} is empty.`);
		names.add(file.filename);
	}
	const directory = realpathSync(await mkdtemp(join(tmpdir(), "browser-task-uploads-")));
	const byPath = new Map<string, BrowserTaskFile>();
	try {
		for (const file of files) {
			const path = join(directory, file.filename);
			await writeFile(path, file.bytes, { flag: "wx", mode: 0o600 });
			byPath.set(path, file);
		}
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	return {
		directory,
		connection: async (endpoint) => uploadingConnection(await CdpConnection.connect({ endpoint, timeoutMs: 30_000 }), byPath),
		dispose: () => rm(directory, { recursive: true, force: true }),
	};
}

/** Runs in the page with `this` bound to the file input: the files become its selection, with the events a user's choice fires. */
function setInputFiles(this: HTMLInputElement, files: { filename: string; mimeType: string; base64: string }[]): number {
	if (!(this instanceof HTMLInputElement) || this.type !== "file") throw new Error("not a file input");
	if (files.length > 1 && !this.multiple) throw new Error("this file input accepts one file");
	const transfer = new DataTransfer();
	for (const file of files) {
		const binary = atob(file.base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
		transfer.items.add(new File([bytes], file.filename, { type: file.mimeType }));
	}
	this.files = transfer.files;
	this.dispatchEvent(new Event("input", { bubbles: true }));
	this.dispatchEvent(new Event("change", { bubbles: true }));
	return this.files.length;
}

/**
 * The connection the agent uses, with `DOM.setFileInputFiles` answered from
 * the staged bytes; every other command and event passes through unchanged.
 * A path that is not a staged file is refused, never passed to the browser.
 */
export function uploadingConnection(connection: CdpConnection, files: ReadonlyMap<string, BrowserTaskFile>): CdpConnection {
	const send: CdpConnection["send"] = async (method, params = {}, sessionId, timeoutMs) => {
		if (method !== "DOM.setFileInputFiles") return connection.send(method, params, sessionId, timeoutMs);
		const paths = Array.isArray(params.files) ? params.files : [];
		const staged = paths.map((path) => {
			const file = typeof path === "string" ? files.get(path) : undefined;
			if (!file) throw new Error(`upload file ${String(path)} is not a staged file`);
			return { filename: file.filename, mimeType: file.mimeType, base64: file.bytes.toString("base64") };
		});
		if (staged.length === 0) throw new Error("upload names no files");
		const { objectId, backendNodeId } = params;
		if (typeof objectId !== "string" && typeof backendNodeId !== "number") throw new Error("upload needs the file input's object id or backend node id");
		try {
			// A file chooser names its input by backend node: resolve it in the same session.
			const input = typeof objectId === "string"
				? objectId
				: (await connection.send("DOM.resolveNode", { backendNodeId, objectGroup: OBJECT_GROUP }, sessionId) as { object: { objectId?: string } }).object.objectId;
			if (!input) throw new Error("the file input is gone");
			const answer = await connection.send("Runtime.callFunctionOn", {
				objectId: input,
				functionDeclaration: setInputFiles.toString(),
				arguments: [{ value: staged }],
				returnByValue: true,
				awaitPromise: false,
			}, sessionId, Math.max(timeoutMs ?? 0, SET_FILES_TIMEOUT_MS)) as { exceptionDetails?: { exception?: { description?: string }; text?: string } };
			if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "setting the files failed");
			return {};
		} finally {
			if (typeof objectId !== "string") await connection.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }, sessionId).catch(() => undefined);
		}
	};
	return new Proxy(connection, {
		get(target, property) {
			if (property === "send") return send;
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";

import type { CdpConnection } from "browser-fabric/packages/worker-runtime/src/cdp-connection";
import { stageUploads, uploadingConnection, type BrowserTaskFile } from "./uploads";

const PNG: BrowserTaskFile = { filename: "shot.png", mimeType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]) };

/** A connection that records what reaches the browser. */
function recorder(answer: unknown = { result: { value: 1 } }) {
	const sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string; timeoutMs?: number }> = [];
	const connection = {
		closed: false,
		send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs?: number) => {
			sent.push({ method, params, ...(sessionId ? { sessionId } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
			return answer;
		},
		onMessage(this: { closed: boolean }) { return this.closed; },
	} as unknown as CdpConnection;
	return { connection, sent };
}

describe("staging upload files", () => {
	test("writes each file privately under a fresh directory and removes it on dispose", async () => {
		const staged = await stageUploads([PNG, { filename: "b.jpg", mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff]) }]);
		expect(readFileSync(`${staged.directory}/shot.png`).equals(PNG.bytes)).toBeTrue();
		expect(statSync(`${staged.directory}/shot.png`).mode & 0o777).toBe(0o600);
		await staged.dispose();
		expect(existsSync(staged.directory)).toBeFalse();
	});

	test.each([
		[[], "No files"],
		[[{ ...PNG, filename: "../shot.png" }], "not a plain file name"],
		[[{ ...PNG, filename: "a/b.png" }], "not a plain file name"],
		[[{ ...PNG, filename: ".hidden" }], "not a plain file name"],
		[[{ ...PNG, filename: "a..png" }], "not a plain file name"],
		[[PNG, PNG], "staged twice"],
		[[{ ...PNG, bytes: Buffer.alloc(0) }], "is empty"],
	] as Array<[BrowserTaskFile[], string]>)("refuses %j", async (files, message) => {
		await expect(stageUploads(files)).rejects.toThrow(message);
	});
});

describe("the uploading connection", () => {
	const files = new Map([["/staged/shot.png", PNG]]);

	test("answers DOM.setFileInputFiles by setting the staged bytes in the page, never by a browser-side path", async () => {
		const { connection, sent } = recorder();
		const wrapped = uploadingConnection(connection, files);
		expect(await wrapped.send("DOM.setFileInputFiles", { files: ["/staged/shot.png"], objectId: "obj-1" }, "session-1")).toEqual({});
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ method: "Runtime.callFunctionOn", sessionId: "session-1", timeoutMs: 60_000, params: { objectId: "obj-1", returnByValue: true, arguments: [{ value: [{ filename: "shot.png", mimeType: "image/png", base64: PNG.bytes.toString("base64") }] }] } });
		expect(String(sent[0]!.params.functionDeclaration)).toContain("DataTransfer");
	});

	test("answers a file chooser's DOM.setFileInputFiles by backend node: resolves the input in its session, sets the bytes there, releases the handle", async () => {
		const { connection, sent } = recorder({ object: { objectId: "node-obj" } });
		const wrapped = uploadingConnection(connection, files);
		expect(await wrapped.send("DOM.setFileInputFiles", { files: ["/staged/shot.png"], backendNodeId: 42 }, "frame-session")).toEqual({});
		expect(sent.map((command) => `${command.method} ${command.sessionId}`)).toEqual(["DOM.resolveNode frame-session", "Runtime.callFunctionOn frame-session", "Runtime.releaseObjectGroup frame-session"]);
		expect(sent[0]!.params).toEqual({ backendNodeId: 42, objectGroup: "browser-task-uploads" });
		expect(sent[1]!.params).toMatchObject({ objectId: "node-obj", arguments: [{ value: [{ filename: "shot.png", mimeType: "image/png", base64: PNG.bytes.toString("base64") }] }] });
		expect(sent[2]!.params).toEqual({ objectGroup: "browser-task-uploads" });
	});

	test("releases the resolved input also when the page refuses the files", async () => {
		const sent: string[] = [];
		const connection = {
			send: async (method: string) => {
				sent.push(method);
				if (method === "DOM.resolveNode") return { object: { objectId: "node-obj" } };
				if (method === "Runtime.callFunctionOn") return { exceptionDetails: { exception: { description: "Error: this file input accepts one file" } } };
				return {};
			},
		} as unknown as CdpConnection;
		await expect(uploadingConnection(connection, files).send("DOM.setFileInputFiles", { files: ["/staged/shot.png"], backendNodeId: 7 }, "s")).rejects.toThrow("accepts one file");
		expect(sent).toEqual(["DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObjectGroup"]);
	});

	test("refuses paths that are not staged, an empty selection and a missing input, without touching the browser", async () => {
		const { connection, sent } = recorder();
		const wrapped = uploadingConnection(connection, files);
		await expect(wrapped.send("DOM.setFileInputFiles", { files: ["/etc/hosts"], objectId: "obj-1" })).rejects.toThrow("not a staged file");
		await expect(wrapped.send("DOM.setFileInputFiles", { files: [], objectId: "obj-1" })).rejects.toThrow("names no files");
		await expect(wrapped.send("DOM.setFileInputFiles", { files: ["/staged/shot.png"] })).rejects.toThrow("object id");
		expect(sent).toEqual([]);
	});

	test("reports the page's refusal", async () => {
		const { connection } = recorder({ exceptionDetails: { exception: { description: "Error: this file input accepts one file" } } });
		await expect(uploadingConnection(connection, files).send("DOM.setFileInputFiles", { files: ["/staged/shot.png"], objectId: "o" })).rejects.toThrow("accepts one file");
	});

	test("passes every other command and member through to the real connection", async () => {
		const { connection, sent } = recorder({ ok: true });
		const wrapped = uploadingConnection(connection, files);
		expect(await wrapped.send("Page.navigate", { url: "https://example.com" }, "s", 5)).toEqual({ ok: true });
		expect(sent).toEqual([{ method: "Page.navigate", params: { url: "https://example.com" }, sessionId: "s", timeoutMs: 5 }]);
		expect(wrapped.closed).toBeFalse();
		expect((wrapped as unknown as { onMessage(): boolean }).onMessage()).toBeFalse();
	});
});

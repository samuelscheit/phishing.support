import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser } from "rebrowser-puppeteer-core";

import { runFabricBrowserTask, type FabricCdpSessionAcquirer } from "./fabric";
import { chromiumAvailable, html, launchTestChromium, refIn, ScriptedModel, type ScriptedTurn } from "./test_helpers";
import type { BrowserTaskFile } from "./uploads";

/**
 * Attaching a task's files to forms that show no file input, as provider
 * forms build them, through the connection that maps the agent's
 * `DOM.setFileInputFiles` to the staged bytes: for an input styled out of
 * sight (by `objectId`) and for the input of a file chooser a click on an
 * attachment control opened (by `backendNodeId`).
 */

const PNG: BrowserTaskFile = { filename: "shot.png", mimeType: "image/png", bytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400_000, 7)]) };
const JPEG: BrowserTaskFile = { filename: "shot.jpg", mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
const sha256 = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
/** What a fixture prints for files it received: name, type, size and SHA-256 of the bytes, as the provider would store them. */
const received = (how: string, ...files: BrowserTaskFile[]) => `${how}: ${files.map((file) => `${file.filename} ${file.mimeType} ${file.bytes.byteLength} ${sha256(file.bytes)}`).join(" | ")}`;

/** Fixture script: `report(how, files)` appends what the page received to #out. */
const REPORTER = `<div id="out"></div><script>
async function report(how, files) {
	const parts = [];
	for (const file of files) {
		const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
		parts.push(file.name + ' ' + file.type + ' ' + file.size + ' ' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''));
	}
	const line = document.createElement('p');
	line.textContent = how + ': ' + parts.join(' | ');
	document.getElementById('out').append(line);
}
</script>`;

/** Zendesk's request form (as on support.squarespace.com): a transparent multi-file input laid over the drop area. */
const ZENDESK = `<h1>Submit a request</h1>
<style>.upload-dropzone { position: relative; border: 1px dashed #999; padding: 12px; width: 420px } .upload-dropzone input { position: absolute; inset: 0; opacity: 0; width: 100% }</style>
<form id="new_request" method="post" action="/requests">
	<label for="request-attachments">Attachments<span class="optional">(optional)</span></label>
	<div id="upload-dropzone" class="upload-dropzone">
		<input type="file" multiple id="request-attachments">
		<span><a>Add file</a> or drop files here</span>
	</div>
</form>${REPORTER}<script>
document.getElementById('request-attachments').addEventListener('change', (event) => report('zendesk', event.target.files));
</script>`;

/** dropzone.js: the zone is the form; its hidden input lives at the end of <body>, opened by a click on the zone. */
const DROPZONE = `<h1>Upload evidence</h1>
<form class="dropzone" id="zone" style="border: 2px dashed; padding: 30px; width: 420px; cursor: pointer"><div class="dz-message">Drop files here or click to upload</div></form>
${REPORTER}<script>
const hidden = document.createElement('input');
hidden.type = 'file'; hidden.multiple = true; hidden.className = 'dz-hidden-input';
hidden.style.cssText = 'visibility: hidden; position: absolute; top: 0; left: 0; height: 0; width: 0;';
document.body.append(hidden);
hidden.addEventListener('change', () => report('dropzone', hidden.files));
document.getElementById('zone').addEventListener('click', () => hidden.click());
</script>`;

/** A single-file input behind its button. */
const SINGLE = `<h1>Evidence</h1><input type="file" id="one" hidden><button type="button" onclick="document.getElementById('one').click()">Attach screenshot</button>${REPORTER}<script>
document.getElementById('one').addEventListener('change', (event) => report('single', event.target.files));
</script>`;

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
	if (!chromiumAvailable) return;
	server = Bun.serve({
		port: 0,
		fetch: (request) => {
			const { pathname } = new URL(request.url);
			// localhost is another site than 127.0.0.1, so Chromium runs the frame out of process.
			if (pathname === "/framed") return html(`<h1>Support</h1><iframe src="http://localhost:${server.port}/dropzone" style="width: 700px; height: 400px"></iframe>`);
			const pages: Record<string, string> = { "/zendesk": ZENDESK, "/dropzone": DROPZONE, "/single": SINGLE };
			return html(pages[pathname] ?? "<h1>Not found</h1>");
		},
	});
	browser = await launchTestChromium();
});
afterAll(async () => {
	await browser?.close();
	server?.stop(true);
});

const acquire: FabricCdpSessionAcquirer = async () => ({
	id: "browser-session_test",
	cdpEndpoint: browser.wsEndpoint(),
	release: async () => undefined,
	cancel: async () => undefined,
});

/** Run scripted turns on a fixture with the task's files; returns every observation the model saw and the actions. */
async function run(path: string, turns: ScriptedTurn[], files: BrowserTaskFile[] = [PNG, JPEG]) {
	const observations: string[] = [];
	const model = new ScriptedModel([...turns, () => ({ calls: [{ name: "done", arguments: { result: "ok", summary: "done" } }] })].map((turn): ScriptedTurn => (page, request) => {
		observations.push(page);
		return turn(page, request);
	}));
	const result = await runFabricBrowserTask({
		task: { goal: "Attach the screenshots.", startUrl: `http://127.0.0.1:${server.port}${path}`, maxSteps: turns.length + 2, resultSchema: { type: "string" } },
		model,
		egress: "reporting",
		metadata: {},
		timeoutMs: 60_000,
		started: async () => true,
		acquire,
		files,
	});
	return { observations, actions: result?.steps.flatMap((step) => step.actions) ?? [], model };
}

const upload = (label: string, paths: string[]): ScriptedTurn => (page) => ({ calls: [{ name: "upload", arguments: { ref: refIn(page, label), paths } }] });

describe.skipIf(!chromiumAvailable)("attaching a task's files to forms without a visible file input (real Chromium, scripted model)", () => {
	test("Zendesk: the transparent input is listed by its label, and upload sets the staged bytes on it", async () => {
		const { observations, actions, model } = await run("/zendesk", [
			(page, request) => {
				expect(request.tools?.find((tool) => tool.name === "upload")?.description).toContain("the control that opens its file picker");
				return upload("file-input \"Attachments(optional)\"", ["shot.png", "shot.jpg"])(page, request);
			},
		]);
		expect(actions[0]).toMatchObject({ tool: "upload", ok: true });
		expect(observations[1]).toContain(received("zendesk", PNG, JPEG));
		expect(observations[1]).toContain("file-input \"Attachments(optional)\" value=\"shot.png, shot.jpg\"");
		expect(model.seen()).not.toContain("A file chooser opened");
	}, 60_000);

	test("dropzone.js: upload on the drop area answers the chooser its click opens with the staged bytes", async () => {
		const { observations, actions } = await run("/dropzone", [upload("Drop files here or click to upload", ["shot.jpg", "shot.png"])]);
		expect(actions[0]).toMatchObject({ tool: "upload", ok: true });
		expect(observations[1]).toContain(received("dropzone", JPEG, PNG));
	}, 60_000);

	test("the same in a cross-site (out-of-process) frame", async () => {
		const { observations } = await run("/framed", [
			(page, request) => {
				expect(refIn(page, "Drop files here or click to upload")).toMatch(/^f\d+e\d+$/);
				return upload("Drop files here or click to upload", ["shot.png"])(page, request);
			},
		]);
		// The frame's text is in the observation's frame excerpt.
		expect(observations[1]).toContain(received("dropzone", PNG));
	}, 60_000);

	test("a single-file chooser takes one staged file; two are refused, and a file outside the staged set never reaches it", async () => {
		const { observations, actions } = await run("/single", [
			upload("button \"Attach screenshot\"", ["shot.png", "shot.jpg"]),
			upload("button \"Attach screenshot\"", ["/etc/hosts"]),
			upload("button \"Attach screenshot\"", ["shot.jpg"]),
		]);
		expect(actions.slice(0, 3).map((action) => `${action.tool}:${action.ok}`)).toEqual(["upload:false", "upload:false", "upload:true"]);
		expect(actions[0]?.output).toContain("accepts one file");
		expect(actions[1]?.output).toContain("outside the allowed directories");
		expect(observations[3]).toContain(received("single", JPEG));
		expect(observations[3]).not.toContain("shot.png");
	}, 60_000);
});

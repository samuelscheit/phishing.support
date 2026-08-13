import { readFileSync } from "node:fs";

const extensionId = "ejagiilfhmflpcohicichiokfoofeljp";
const endpoint = "http://127.0.0.1:9222";
const optionsUrl = `chrome-extension://${extensionId}/options/options.html`;

function secretFromPath(path) {
	const value = readFileSync(path, "utf8").trim();
	if (!value) throw new Error(`Credential file ${path} is empty.`);
	return value;
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function json(path) {
	const response = await fetch(`${endpoint}${path}`, { cache: "no-store" });
	if (!response.ok) throw new Error(`CDP request ${path} failed with HTTP ${response.status}.`);
	return response.json();
}

async function waitForCdp() {
	let lastError;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const version = await json("/json/version");
			if (typeof version.webSocketDebuggerUrl === "string") return;
		} catch (error) {
			lastError = error;
		}
		await sleep(500);
	}
	throw lastError ?? new Error("Chrome CDP did not become available.");
}

async function connect(socketUrl) {
	const socket = new WebSocket(socketUrl);
	const state = { nextId: 1, pending: new Map() };
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", () => reject(new Error("Could not open the Chrome CDP socket.")), { once: true });
	});
	socket.addEventListener("message", (event) => {
		let message;
		try {
			message = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = state.pending.get(message.id);
		if (!pending) return;
		state.pending.delete(message.id);
		if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed."));
		else pending.resolve(message.result);
	});
	const call = (method, params = {}) => {
		const id = state.nextId++;
		const result = new Promise((resolve, reject) => state.pending.set(id, { resolve, reject }));
		socket.send(JSON.stringify({ id, method, params }));
		return result;
	};
	const close = () => {
		for (const pending of state.pending.values()) pending.reject(new Error("CDP socket closed."));
		state.pending.clear();
		socket.close();
	};
	return { call, close };
}

async function createOptionsTarget() {
	const version = await json("/json/version");
	if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("Chrome did not expose the browser CDP socket.");
	const browser = await connect(version.webSocketDebuggerUrl);
	try {
		const created = await browser.call("Target.createTarget", { url: optionsUrl });
		if (typeof created.targetId !== "string") throw new Error("Chrome did not create the DBC extension options target.");
		return created.targetId;
	} finally {
		browser.close();
	}
}

async function waitForTargetSocket(targetId) {
	let lastTargets = [];
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const targets = await json("/json/list");
			lastTargets = Array.isArray(targets) ? targets : [];
			const target = lastTargets.find((item) => item?.id === targetId || item?.url === optionsUrl);
			if (typeof target?.webSocketDebuggerUrl === "string") return target.webSocketDebuggerUrl;
		} catch {
			// Chrome may briefly reload the extension page while starting its service worker.
		}
		await sleep(250);
	}
	throw new Error(`DBC extension options target did not expose a debuggable socket (targets: ${lastTargets.map((target) => target?.url).join(", ")}).`);
}

async function evaluate(target, expression) {
	const result = await target.call("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
		userGesture: false,
	});
	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.text ?? "DBC extension evaluation failed.");
	}
	if (!result.result) throw new Error("DBC extension evaluation returned no result.");
	return result.result.value;
}

async function bootstrap() {
	const username = secretFromPath(process.env.DBC_USERNAME_FILE ?? "/run/secrets/dbc_username");
	const password = secretFromPath(process.env.DBC_PASSWORD_FILE ?? "/run/secrets/dbc_password");
	await waitForCdp();
	const targetId = await createOptionsTarget();
	const targetSocketUrl = await waitForTargetSocket(targetId);
	const target = await connect(targetSocketUrl);
	try {
		const setExpression = `new Promise((resolve, reject) => {
			if (!globalThis.chrome?.storage?.local) return reject(new Error("chrome.storage.local is unavailable"));
			chrome.storage.local.set({ config: { userName: ${JSON.stringify(username)}, passWord: ${JSON.stringify(password)} } }, () => {
				const error = chrome.runtime.lastError;
				if (error) reject(new Error(error.message));
				else resolve(true);
			});
		})`;
		if (await evaluate(target, setExpression) !== true) throw new Error("DBC extension refused its configuration write.");
		const verified = await evaluate(target, `new Promise((resolve, reject) => {
			chrome.storage.local.get("config", (result) => {
				const error = chrome.runtime.lastError;
				if (error) reject(new Error(error.message));
				else resolve({ configured: Boolean(result.config), keys: result.config && typeof result.config === "object" ? Object.keys(result.config).sort() : [] });
			});
		})`);
		if (!verified || verified.configured !== true || JSON.stringify(verified.keys) !== JSON.stringify(["passWord", "userName"])) {
			throw new Error("DBC extension credential storage could not be verified.");
		}
	} finally {
		target.close();
	}
}

bootstrap().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});

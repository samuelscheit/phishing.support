import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium as patchrightChromium, type Browser as PatchrightBrowser } from "patchright";
import puppeteer, { type Browser } from "rebrowser-puppeteer-core";

import type { ChatModel, ChatRequest } from "./agent";
import type { ChatResponse, ToolCall } from "browser-fabric/packages/task-agent/src/index";

/**
 * Test support for browser tasks: a real Chromium the test launches itself
 * (throwaway profile), local fixture sites, and a scripted model that plays
 * the agent's turns by reading element refs from each observation.
 */

const chromiumExecutable = process.env.PHISHING_TEST_CHROMIUM
	?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
export const chromiumAvailable = await Bun.file(chromiumExecutable).exists();

/**
 * A headless Chromium with a throwaway profile; `hosts` maps `name:443` to
 * local fixture ports. The tests' loopback servers stand in for distinct
 * public sites, and a page a capture answers from DevTools is public-like to
 * Chromium (see `document_bodies`): Local Network Access would block the
 * loopback frames and requests that a public page's public ones never meet.
 */
export async function launchTestChromium(hosts: Record<string, number> = {}): Promise<Browser> {
	const rules = Object.entries(hosts).map(([host, port]) => `MAP ${host}:443 127.0.0.1:${port}`).join(",");
	return puppeteer.launch({
		executablePath: chromiumExecutable,
		headless: true,
		args: ["--no-first-run", "--disable-features=LocalNetworkAccessChecks", ...(rules ? [`--host-resolver-rules=${rules}`, "--ignore-certificate-errors"] : [])],
	});
}

/** The same headless Chromium driven by Patchright, the client of the provider forms (its `evaluate` defaults to an isolated world). */
export function launchTestPatchright(): Promise<PatchrightBrowser> {
	return patchrightChromium.launch({ executablePath: chromiumExecutable, headless: true });
}

/** A self-signed certificate for a local HTTPS fixture (the browser ignores certificate errors). */
export function selfSignedCertificate(hostname: string): { key: string; cert: string } {
	const directory = mkdtempSync(join(tmpdir(), "phishing-test-tls-"));
	try {
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${hostname}`, "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
		return { key: readFileSync(join(directory, "key.pem"), "utf8"), cert: readFileSync(join(directory, "cert.pem"), "utf8") };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export const html = (body: string, title = "Fixture") =>
	new Response(`<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

/** Every text part of a request, as the model received it. */
export function requestTexts(request: ChatRequest): string[] {
	const texts: string[] = [request.system];
	for (const message of request.messages) {
		if (message.role === "assistant") texts.push(message.text, JSON.stringify(message.toolCalls));
		else for (const part of message.role === "user" ? message.content : message.results.flatMap((result) => result.content)) if (part.type === "text") texts.push(part.text);
	}
	return texts;
}

/** The newest observation in a request. */
function latestObservation(request: ChatRequest): string {
	const observation = requestTexts(request).filter((text) => text.startsWith("Current page:")).at(-1);
	if (!observation) throw new Error("no observation in request");
	return observation;
}

/** The ref of the first observed element whose line contains `pattern` (`textbox "Domain"`). */
export function refIn(observation: string, pattern: string): string {
	const line = observation.split("\n").find((candidate) => candidate.includes(pattern));
	const match = line && /^\[((?:f\d+)?e\d+)\]/.exec(line.trim());
	if (!match) throw new Error(`no element ${pattern} in\n${observation}`);
	return match[1]!;
}

export type ScriptedTurn = (observation: string, request: ChatRequest) =>
	{ text?: string; calls: Array<Omit<ToolCall, "id">> } | Promise<{ text?: string; calls: Array<Omit<ToolCall, "id">> }>;

/**
 * A deterministic model: each request plays the next scripted turn. It keeps
 * every request, so a test can check what the model was (never) shown.
 */
export class ScriptedModel implements ChatModel {
	readonly id = "test/scripted";
	readonly requests: ChatRequest[] = [];
	#calls = 0;

	constructor(private readonly turns: ScriptedTurn[]) {}

	async complete(request: ChatRequest): Promise<ChatResponse> {
		this.requests.push(request);
		const turn = this.turns.shift();
		if (!turn) throw new Error("script exhausted");
		const { text = "", calls } = await turn(latestObservation(request), request);
		return { text, toolCalls: calls.map((call) => ({ id: `call_${++this.#calls}`, ...call })), usage: { inputTokens: 100, outputTokens: 10 }, stopReason: "tool_use" };
	}

	/** Everything the model was sent, joined. */
	seen(): string {
		return this.requests.flatMap(requestTexts).join("\n");
	}
}

/** A model whose turn never ends until the run is aborted. */
export class StalledModel implements ChatModel {
	readonly id = "test/stalled";
	async complete(request: ChatRequest): Promise<ChatResponse> {
		return new Promise((_resolve, reject) => {
			request.signal?.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
		});
	}
}

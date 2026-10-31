#!/usr/bin/env node

import crypto from "node:crypto";
import tls from "node:tls";
import WebSocket, { createWebSocketStream } from "ws";
import { splitHttpResponse } from "./http.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function requiredEnvironment(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function parseArguments(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (!name?.startsWith("--") || value === undefined) throw new Error("arguments must be --name value pairs");
		values.set(name.slice(2), value);
	}
	const domain = values.get("domain");
	const ip = values.get("ip");
	if (!domain || !ip) throw new Error("--domain and --ip are required");
	return {
		domain,
		ip,
		path: values.get("path") || "/",
		timeoutMs: Number(values.get("timeout-ms") || DEFAULT_TIMEOUT_MS),
	};
}

function openTunnel(workerUrl, token, ip, timeoutMs) {
	return new Promise((resolve, reject) => {
		const url = new URL(`/v1/tcp/${ip}`, workerUrl);
		const webSocket = new WebSocket(url, { headers: { "x-origin-probe-token": token }, handshakeTimeout: timeoutMs });
		const timer = setTimeout(() => {
			webSocket.terminate();
			reject(new Error("Worker tunnel timed out"));
		}, timeoutMs);
		webSocket.once("open", () => {
			clearTimeout(timer);
			resolve(webSocket);
		});
		webSocket.once("unexpected-response", (_request, response) => {
			clearTimeout(timer);
			reject(new Error(`Worker tunnel rejected the request with HTTP ${response.statusCode}`));
		});
		webSocket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

async function probe({ workerUrl, token, domain, ip, path, timeoutMs }) {
	const webSocket = await openTunnel(workerUrl, token, ip, timeoutMs);
	const transport = createWebSocketStream(webSocket, { encoding: null });
	const secureSocket = tls.connect({
		socket: transport,
		servername: domain,
		ALPNProtocols: ["http/1.1"],
		rejectUnauthorized: false,
	});

	const chunks = [];
	let bytes = 0;
	let certificate = null;
	let tlsAuthorized = false;
	let tlsAuthorizationError = null;
	let response;
	try {
		response = await new Promise((resolve, reject) => {
			let tlsConnected = false;
			const timer = setTimeout(() => reject(new Error("TLS/HTTP probe timed out")), timeoutMs);
			secureSocket.once("secureConnect", () => {
				tlsConnected = true;
				certificate = secureSocket.getPeerCertificate();
				tlsAuthorized = secureSocket.authorized;
				tlsAuthorizationError = secureSocket.authorizationError || null;
				secureSocket.write(
					`GET ${path} HTTP/1.1\r\nHost: ${domain}\r\nUser-Agent: Phishing-Support-Origin-Probe/1.0\r\nAccept: text/html,application/xhtml+xml,*/*;q=0.1\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
				);
			});
			secureSocket.on("data", (chunk) => {
				bytes += chunk.length;
				if (bytes > MAX_RESPONSE_BYTES) {
					reject(new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`));
					return;
				}
				chunks.push(chunk);
			});
			secureSocket.once("end", () => {
				clearTimeout(timer);
				if (!tlsConnected) reject(new Error("upstream closed before completing the TLS handshake"));
				else resolve(Buffer.concat(chunks));
			});
			secureSocket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			webSocket.once("close", (code, reason) => {
				if (tlsConnected) return;
				clearTimeout(timer);
				reject(new Error(`Worker tunnel closed before TLS handshake (code ${code}${reason.length ? `: ${reason.toString()}` : ""})`));
			});
		});
	} catch (error) {
		secureSocket.destroy();
		webSocket.terminate();
		throw error;
	}

	secureSocket.destroy();
	webSocket.terminate();
	const parsed = splitHttpResponse(response);
	const bodyText = parsed.body.toString("utf8");
	const visibleText = bodyText.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
	const cloudflareErrorCode = visibleText.match(/Error\s+code\s+(\d+)/i)?.[1] ?? null;
	return {
		ip,
		domain,
		path,
		httpStatus: parsed.status,
		headers: parsed.headers,
		bodyBytes: parsed.body.length,
		bodySha256: crypto.createHash("sha256").update(parsed.body).digest("hex"),
		bodyPreview: bodyText.replace(/\s+/g, " ").trim().slice(0, 500),
		markers: {
			cloudflareErrorCode,
			cloudflare1034: cloudflareErrorCode === "1034",
			edgeIpRestricted: /Edge IP Restricted/i.test(bodyText),
			googleSignIn: /Sign in with your Google Account/i.test(bodyText),
			emailOrPhone: /Email or phone/i.test(bodyText),
		},
		tls: {
			authorized: tlsAuthorized,
			authorizationError: tlsAuthorizationError,
			subject: certificate?.subject ?? null,
			subjectAltName: certificate?.subjectaltname ?? null,
			fingerprint256: certificate?.fingerprint256 ?? null,
			validFrom: certificate?.valid_from ?? null,
			validTo: certificate?.valid_to ?? null,
		},
	};
}

const args = parseArguments(process.argv.slice(2));
const workerUrl = requiredEnvironment("ORIGIN_PROBE_WORKER_URL");
const token = requiredEnvironment("ORIGIN_PROBE_TOKEN");

try {
	console.log(JSON.stringify(await probe({ workerUrl, token, ...args })));
} catch (error) {
	console.log(
		JSON.stringify({
			ip: args.ip,
			domain: args.domain,
			path: args.path,
			error: error instanceof Error ? error.message : String(error),
		}),
	);
	process.exitCode = 1;
}

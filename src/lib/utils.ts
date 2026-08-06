// import { Browser, launch } from "puppeteer-core";
import path from "path";
import fs from "fs";
import { tmpdir } from "os";

import {
	CDPSession,
	Frame,
	HTTPResponse,
	launch,
	Page,
	Protocol,
	PuppeteerLifeCycleEvent,
	type Browser,
	type GoToOptions,
} from "rebrowser-puppeteer-core";
import sanitize from "sanitize-filename";
import OpenAI from "openai";
import { config } from "dotenv";
import type { Stream } from "openai/streaming";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.mjs";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";
import axios from "axios";
import { extractResponseOutputText, parseResponseJson } from "./openai_response";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config({
	path: path.join(__dirname, "..", "..", ".env"),
	quiet: true,
});

export function pathSafeFilename(input: string, { fallback = "file", maxLen = 180 } = {}) {
	let s = sanitize(input.replaceAll("/", "_")).trim();

	// Windows-Sonderfall: keine abschließenden Punkte/Spaces
	s = s.replace(/[. ]+$/g, "");

	// Leere/ungültige Ergebnisse abfangen
	if (!s || s === "." || s === "..") s = fallback;

	// Länge begrenzen (Platz für Erweiterung lassen)
	if (s.length > maxLen) s = s.slice(0, maxLen);

	return s;
}

export async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retry<T>(fn: () => Promise<T>, retries: number = 3, delayMs: number = 5000): Promise<T> {
	return fn().catch((err) => {
		if (retries > 0) {
			return sleep(delayMs).then(() => retry(fn, retries - 1, delayMs));
		}
		return Promise.reject(err);
	});
}

export async function logStream(response: Stream<ResponseStreamEvent>) {
	for await (const chunk of response) {
		if (chunk.type === "response.output_text.delta") {
			process.stdout.write(chunk.delta);
		} else if (chunk.type === "response.reasoning_summary_text.delta") {
			process.stdout.write(chunk.delta);
		} else if (chunk.type === "response.reasoning_summary_part.done") {
			process.stdout.write("\n[Reasoning Summary Completed]\n");
		} else if (chunk.type === "response.reasoning_summary_part.added") {
			process.stdout.write("\n[Reasoning Summary Added]\n");
		} else if (chunk.type === "response.in_progress") {
			process.stdout.write("\n[Response In Progress]\n");
		} else if (chunk.type === "response.created") {
			process.stdout.write("\n[Response Created]\n");
		} else if (chunk.type === "response.content_part.done") {
			process.stdout.write("\n[Content Part Completed]\n");
		} else if (chunk.type === "response.content_part.added") {
			process.stdout.write("\n[Content Part Added]\n");
		} else if (chunk.type === "response.output_text.done") {
			process.stdout.write("\n[Output Text Completed]\n");
		} else if (chunk.type === "response.reasoning_summary_text.done") {
			process.stdout.write("\n[Reasoning Text Completed]\n");
		} else if (chunk.type === "response.web_search_call.in_progress") {
			process.stdout.write("\n[Web Search in progress...]\n");
		} else if (chunk.type === "response.web_search_call.searching") {
			process.stdout.write(`\n[Searching the web]`);
		} else if (chunk.type === "response.web_search_call.completed") {
			process.stdout.write(`\n[Web Search completed]`);
		} else if (chunk.type === "response.output_item.done") {
			process.stdout.write(`\n[Output item done]\n`);
		} else if (chunk.type === "response.output_item.added") {
			process.stdout.write(`\n[Output item added]\n`);
		} else if (chunk.type === "response.output_text.annotation.added") {
			if ((chunk.annotation as any).url) {
				process.stdout.write(` (${(chunk.annotation as any).url}) `);
			} else {
				console.dir(chunk.annotation, { depth: null });
			}
		} else if (chunk.type === "response.completed") {
			const output_text = extractResponseOutputText(chunk.response);
			let output_parsed = null;

			if (chunk.response.status === "completed") {
				try {
					output_parsed = parseResponseJson(chunk.response, output_text);
				} catch (error) {
					throw new Error(`Failed to parse output text as JSON: ${error}\n\nOutput Text:\n${output_text}`);
				}
			}

			return {
				...chunk.response,
				output_text,
				output_parsed,
			};
		} else {
			console.dir(chunk, { depth: null });
		}
	}

	throw new Error("Stream ended without completion");
}

const smtpHost = process.env.SMTP_HOST || "smtp.ethereal.email";
const smtpPort = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 587;
const smtpSecure = process.env.SMTP_SECURE !== undefined ? process.env.SMTP_SECURE === "true" : smtpPort === 465;
const smtpUser = process.env.SMTP_USER || "maddison53@ethereal.email";
const smtpPass = process.env.SMTP_PASS || "jn7jnAPss4f63QBp6D";

if (smtpSecure && smtpPort === 587) {
	console.warn("SMTP_SECURE=true with port 587 can cause TLS errors; use SMTP_SECURE=false for STARTTLS.");
}

export const mailer =
	smtpHost && smtpPort && smtpUser && smtpPass
		? nodemailer.createTransport({
				host: smtpHost,
				port: smtpPort,
				secure: smtpSecure,
				auth: {
					user: smtpUser,
					pass: smtpPass,
				},
			})
		: undefined;

export const max_output_tokens = 30000;
export const defaultResponseModel = process.env.OPENAI_MODEL || "gpt-5.5";
export const defaultReasoning = {
	effort: "xhigh",
	summary: "detailed",
} as const;

export const model = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY ?? "",
	baseURL: process.env.OPENAI_API_BASE_URL || "https://api.openai.com/v1",
	fetchOptions: {
		verbose: process.env.OPENAI_VERBOSE === "true",
	},
});

export async function getUserCC(req: Request) {
	try {
		const ip = req.headers.get("CF-Connecting-IP") || req.headers.get("x-forwarded-for");
		if (!ip) throw new Error("No IP found");

		console.log("Fetching country code for IP:", ip);

		const response = await axios(`https://api.country.is/${ip}`);

		console.log("Country code response:", response.data);
		return response.data.country as string;
	} catch (error) {}
	return "de";
}

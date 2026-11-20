/** The OpenAI client and the model every analysis uses. */
import OpenAI from "openai";

export const defaultResponseModel = process.env.OPENAI_MODEL || "gpt-5.5";
export const defaultReasoning = {
	effort: "xhigh",
	summary: "detailed",
} as const;

/**
 * Builds the Responses client only when an analysis actually starts.
 *
 * Route modules are evaluated during `next build`; constructing the OpenAI
 * client there makes the image build depend on a runtime-only API key. Keeping
 * this boundary lazy also produces a clear operational error when a deployed
 * worker receives an analysis request without credentials.
 */
export function getOpenAIClient(): OpenAI {
	const client = buildClient();
	if (!client) throw new Error("OPENAI_API_KEY is required to run AI analysis.");
	return client;
}

/** Bound on each optional call (report drafting, reply classification). */
const OPTIONAL_CALL_TIMEOUT_MS = 45_000;

/**
 * A bounded client for report drafting and reply classification. Unlike the
 * analyser, these calls are optional: a missing key yields no client and a
 * failing model falls back to deterministic text instead of blocking a report.
 */
export function optionalOpenAIClient(): OpenAI | undefined {
	return buildClient(OPTIONAL_CALL_TIMEOUT_MS);
}

function buildClient(timeout?: number): OpenAI | undefined {
	const apiKey = process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) return undefined;
	return new OpenAI({ apiKey, baseURL: process.env.OPENAI_API_BASE_URL?.trim() || "https://api.openai.com/v1", ...(timeout ? { timeout } : {}) });
}

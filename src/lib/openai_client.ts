/** The OpenAI client and the model every analysis uses; importing it loads `.env`. */
import path from "path";
import OpenAI from "openai";
import { config } from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config({
	path: path.join(__dirname, "..", "..", ".env"),
	quiet: true,
});

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
	const apiKey = process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) throw new Error("OPENAI_API_KEY is required to run AI analysis.");

	return new OpenAI({
		apiKey,
		baseURL: process.env.OPENAI_API_BASE_URL?.trim() || "https://api.openai.com/v1",
		logLevel: process.env.OPENAI_VERBOSE === "true" ? "debug" : undefined,
	});
}

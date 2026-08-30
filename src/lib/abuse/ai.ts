import OpenAI from "openai";

const DEFAULT_ABUSE_AI_TIMEOUT_MS = 45_000;

function abuseAiTimeoutMs(): number {
	const configured = Number.parseInt(process.env.ABUSE_OPENAI_TIMEOUT_MS ?? "", 10);
	return Number.isSafeInteger(configured) && configured >= 5_000 && configured <= 5 * 60_000
		? configured
		: DEFAULT_ABUSE_AI_TIMEOUT_MS;
}

/**
 * Create the narrowly scoped OpenAI client used by the standalone abuse
 * service. Keeping this separate from the legacy analyser means an abuse
 * worker can still send its deterministic report when the model is absent or
 * unavailable.
 */
export function configuredAbuseOpenAI(): OpenAI | undefined {
	const apiKey = process.env.ABUSE_OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) return undefined;
	return new OpenAI({
		apiKey,
		baseURL: process.env.ABUSE_OPENAI_API_BASE_URL?.trim() || process.env.OPENAI_API_BASE_URL?.trim() || "https://api.openai.com/v1",
		timeout: abuseAiTimeoutMs(),
	});
}

/** Extract text from both standard Responses responses and compatible gateways. */
export function responseOutputText(response: unknown): string | undefined {
	if (!response || typeof response !== "object") return undefined;
	const direct = (response as { output_text?: unknown }).output_text;
	if (typeof direct === "string" && direct.trim()) return direct;
	const output = (response as { output?: unknown }).output;
	if (!Array.isArray(output)) return undefined;
	const chunks: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
				chunks.push((part as { text: string }).text);
			}
		}
	}
	return chunks.join("\n").trim() || undefined;
}

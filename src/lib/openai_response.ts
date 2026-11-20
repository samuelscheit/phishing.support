import { asRecord, isRecord, type JsonRecord } from "./values";

/**
 * The content parts of every assistant message in a Responses API `output`,
 * one array per message. Reasoning, tool-call and other non-message items carry
 * no answer text and are skipped. Every reader of a response's text starts here
 * so they agree on what the answer is.
 */
export function responseMessageContents(output: unknown): JsonRecord[][] {
	if (!Array.isArray(output)) return [];
	const messages: JsonRecord[][] = [];
	for (const item of output) {
		const message = asRecord(item);
		if (message?.type !== "message" || !Array.isArray(message.content)) continue;
		messages.push(message.content.filter(isRecord));
	}
	return messages;
}

/** Content parts of all assistant messages, flattened. */
export function responseContentParts(output: unknown): JsonRecord[] {
	return responseMessageContents(output).flat();
}

/** The answer text of a completed response; throws when the model refused or returned an unknown part. */
export function extractResponseOutputText(response: { output_text?: string | null; output?: unknown }) {
	const messageTexts = responseContentParts(response.output)
		.map((content) => {
			if (content.type === "output_text") return content.text;
			if (content.type === "refusal") throw new Error(`Model refused to answer: ${content.refusal}`);
			throw new Error(`Unknown output content type: ${JSON.stringify(content)}`);
		})
		.filter((text) => typeof text === "string" && text.length > 0);

	if (messageTexts.length > 0) return messageTexts.join("");
	return response.output_text ?? "";
}

/** The answer text of an optional model call: `output_text`, else every text part of the output; undefined when there is none, never a throw. */
export function optionalResponseText(response: unknown): string | undefined {
	if (!isRecord(response)) return undefined;
	if (typeof response.output_text === "string" && response.output_text.trim()) return response.output_text;
	const chunks = responseContentParts(response.output).map((part) => part.text).filter((text): text is string => typeof text === "string");
	return chunks.join("\n").trim() || undefined;
}

export function parseResponseJson(response: { text?: unknown }, outputText: string) {
	const trimmed = outputText.trim();
	if (!trimmed) return null;
	if (!response.text && !trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	return JSON.parse(trimmed);
}

export function extractResponseOutputText(response: { output_text?: string | null; output?: any[] }) {
	const messageTexts = (response.output ?? [])
		.filter((item) => item?.type === "message")
		.flatMap((message) => message.content ?? [])
		.map((content) => {
			if (content.type === "output_text") return content.text;
			if (content.type === "refusal") throw new Error(`Model refused to answer: ${content.refusal}`);
			throw new Error(`Unknown output content type: ${JSON.stringify(content)}`);
		})
		.filter((text) => typeof text === "string" && text.length > 0);

	if (messageTexts.length > 0) return messageTexts.join("");
	return response.output_text ?? "";
}

export function parseResponseJson(response: { text?: unknown }, outputText: string) {
	const trimmed = outputText.trim();
	if (!trimmed) return null;
	if (!response.text && !trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	return JSON.parse(trimmed);
}

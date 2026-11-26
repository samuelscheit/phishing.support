/** The text with every whitespace run collapsed to one space and the ends trimmed. */
export function squash(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** A provider's answer or an error cause, flattened to one short line for a message. */
export function snippet(text: string, maximum = 300): string {
	return squash(text).slice(0, maximum);
}

/**
 * The text cut to fit `maximum`, at a word boundary when one sits in the last
 * 40% of the cut. With `ellipsis` the text is squashed first, the result ends
 * on a word (no trailing punctuation) and carries "…" when it was cut.
 */
export function truncateAtWord(value: string, maximum: number, { ellipsis = false }: { ellipsis?: boolean } = {}): string {
	if (!ellipsis) {
		if (value.length <= maximum) return value;
		const bounded = value.slice(0, maximum);
		const separator = bounded.lastIndexOf(" ");
		return (separator >= Math.floor(maximum * 0.6) ? bounded.slice(0, separator) : bounded).trim();
	}
	const clean = squash(value);
	if (clean.length <= maximum) return clean;
	const cut = clean.slice(0, maximum - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > maximum * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/**
 * The sentence of `text` that `pattern` matches in, whitespace squashed, or
 * undefined when it matches nowhere. Sentences end at ".", "!" or "?"
 * followed by a space, so "trylevo[.]app." stays one sentence, and at a blank
 * line, so a greeting ("Hello,") is not part of the next one; a sentence
 * wrapped over lines stays whole.
 */
export function sentenceContaining(text: string, pattern: RegExp): string | undefined {
	return text.split(/\n\s*\n/).flatMap((paragraph) => squash(paragraph).split(/(?<=[.!?])\s+/)).find((sentence) => pattern.test(sentence));
}

/** "a", "a and b", "a, b and c". */
export function andList(values: readonly string[]): string {
	return values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

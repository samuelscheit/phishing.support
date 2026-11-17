/**
 * The file number an authority gives a criminal complaint, read from its
 * reply. German prosecutors write an Aktenzeichen such as `401 UJs 12345/26`
 * or `12 Js 345/26`; the police a Tagebuch- or Vorgangsnummer such as
 * `BY1234-005678-26/1`. A reply quotes our own reference too ("Ihr Zeichen"),
 * which is never theirs.
 */
export type CaseReferenceCandidate = { value: string; label: string };

/** A prosecutor's register number: department, register (Js, UJs, Gs …), number, year. */
const PROSECUTOR_FILE = /\b\d{1,4}\s+(?:U?Js|Gs|AR|Zs|VRs|Ds|Ls|Ks|Cs)\s+\d{1,7}\/\d{2}(?:\s*\([^)\n]{1,12}\))?/g;

/** Labels a German authority puts before its own file number. */
const LABELLED = /(?<![\p{L}])(Aktenzeichen|Az\.?|Gesch(?:ä|ae)ftszeichen|Gz\.?|Tgb\.?[\s-]*Nr\.?|Tagebuch[\s-]*(?:nummer|Nr\.?)|Vorgangs[\s-]*(?:nummer|Nr\.?)|Unser(?:e)?\s+(?:Zeichen|Aktenzeichen))\s*[:.]?\s*([A-Z0-9][A-Za-z0-9 ./-]{2,40}[A-Za-z0-9)])/gu;

/** Labels that name the other side's reference, i.e. ours. */
const OUR_REFERENCE = /(?:Ihr(?:e)?\s+(?:Zeichen|Aktenzeichen|Nachricht|Schreiben|Referenz)|Betreff|Subject)\s*[:.]?\s*$/iu;

function cleanValue(value: string): string {
	// A label's value runs to the line end; cut at the first word that is not part of a file number.
	const words = value.trim().split(/\s+/);
	const kept: string[] = [];
	for (const word of words) {
		if (kept.length && !/\d/.test(word) && !/^(?:U?Js|Gs|AR|Zs|VRs|Ds|Ls|Ks|Cs)$/.test(word)) break;
		kept.push(word);
	}
	const joined = kept.join(" ").replace(/[.,;:]+$/, "");
	// A number written in parentheses ("(Az. 7 Js 999/26)") ends before the closing one.
	return joined.includes("(") ? joined : joined.replace(/\)+$/, "");
}

/**
 * Every file number a reply names as the authority's own, each once, prosecutor
 * register numbers first. `ownReferences` are the tags our mails carried; a
 * candidate containing one is our reference quoted back.
 */
export function caseReferenceCandidates(text: string, ownReferences: readonly string[] = []): CaseReferenceCandidate[] {
	const own = ownReferences.map((reference) => reference.toLowerCase()).filter(Boolean);
	const found = new Map<string, CaseReferenceCandidate>();
	const add = (value: string, label: string) => {
		const normalized = value.replace(/\s+/g, " ").trim();
		if (normalized.length < 4 || !/\d/.test(normalized)) return;
		if (own.some((reference) => normalized.toLowerCase().includes(reference) || reference.includes(normalized.toLowerCase()))) return;
		const key = normalized.toLowerCase().replace(/\s+/g, "");
		if (!found.has(key)) found.set(key, { value: normalized, label });
	};
	for (const line of text.split(/\r?\n/)) {
		for (const match of line.matchAll(PROSECUTOR_FILE)) {
			const before = line.slice(0, match.index);
			if (!OUR_REFERENCE.test(before.replace(/[^\S\n]+$/, ""))) add(match[0], "Aktenzeichen");
		}
	}
	for (const line of text.split(/\r?\n/)) {
		for (const match of line.matchAll(LABELLED)) {
			const before = line.slice(0, match.index);
			if (OUR_REFERENCE.test(before.replace(/[^\S\n]+$/, "")) || /Ihr(?:e)?\s*$/i.test(before)) continue;
			const value = cleanValue(match[2]!);
			// A labelled value that is a prosecutor register number was already taken with its exact form.
			if ([...found.values()].some((candidate) => candidate.value.replace(/\s+/g, "") === value.replace(/\s+/g, ""))) continue;
			add(value, match[1]!.replace(/\s+/g, " "));
		}
	}
	return [...found.values()];
}

/** The one file number a reply names, or none when it names none or several. */
export function caseReferenceFrom(text: string, ownReferences: readonly string[] = []): string | undefined {
	const candidates = caseReferenceCandidates(text, ownReferences);
	return candidates.length === 1 ? candidates[0]!.value : undefined;
}

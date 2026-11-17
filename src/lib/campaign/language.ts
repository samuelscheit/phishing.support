/**
 * The language a captured page speaks, from its visitor-readable text. A
 * kit often speaks the visitor's language, so the same campaign shows up in
 * several; the public page names it per site.
 *
 * Latin-script languages are told apart by their most frequent words, other
 * scripts by their characters. A text with too few telling words has no
 * language rather than a guessed one.
 */
const STOPWORDS: Readonly<Record<string, readonly string[]>> = {
	en: ["the", "and", "you", "your", "to", "of", "is", "for", "with", "this", "that", "are", "on", "we", "please", "account", "have", "will", "be", "it"],
	de: ["der", "die", "das", "und", "sie", "ihre", "ihr", "ist", "nicht", "mit", "für", "bitte", "wir", "den", "zu", "auf", "eine", "ein", "werden", "ihrer"],
	da: ["og", "det", "at", "en", "til", "er", "som", "på", "med", "har", "af", "for", "ikke", "din", "dine", "vi", "der", "kan", "jeres", "blevet"],
	no: ["og", "det", "er", "til", "på", "med", "har", "ikke", "din", "dine", "vi", "som", "kan", "av", "blitt", "deg", "kontoen", "vennligst", "ditt", "for"],
	sv: ["och", "det", "att", "är", "en", "på", "för", "med", "har", "inte", "din", "ditt", "vi", "som", "kan", "av", "till", "ditt", "konto", "dig"],
	nl: ["de", "het", "een", "en", "van", "is", "uw", "je", "niet", "met", "voor", "op", "wij", "we", "te", "zijn", "dat", "deze", "wordt", "account"],
	fr: ["le", "la", "les", "et", "vous", "votre", "est", "des", "pour", "pas", "une", "un", "nous", "avec", "sur", "dans", "que", "vos", "ce", "compte"],
	es: ["el", "la", "los", "las", "y", "su", "es", "de", "para", "por", "con", "una", "un", "que", "no", "sus", "su", "cuenta", "usted", "del"],
	it: ["il", "la", "le", "e", "di", "per", "con", "non", "un", "una", "che", "sono", "del", "della", "tuo", "tua", "suo", "account", "è", "ai"],
	pt: ["o", "a", "os", "as", "e", "de", "para", "com", "não", "um", "uma", "que", "sua", "seu", "conta", "do", "da", "você", "é", "em"],
	pl: ["i", "w", "na", "nie", "się", "jest", "do", "z", "że", "to", "twoje", "twoja", "konto", "prosimy", "dla", "przez", "jak", "aby", "lub", "oraz"],
	tr: ["ve", "bir", "bu", "için", "ile", "hesabınız", "lütfen", "olarak", "değil", "da", "de", "sizin", "çok", "daha", "gibi", "olan", "en", "ne", "mi", "hesap"],
	vi: ["và", "của", "là", "cho", "các", "có", "không", "được", "bạn", "với", "này", "trong", "để", "một", "những", "tài", "khoản", "đã", "vui", "lòng"],
	id: ["dan", "yang", "di", "untuk", "anda", "dengan", "tidak", "ini", "akun", "dari", "ke", "akan", "kami", "silakan", "atau", "pada", "sudah", "telah", "adalah", "bisa"],
};

/** Scripts that name their language by themselves. */
const SCRIPTS: ReadonlyArray<[RegExp, string]> = [
	[/[\u3040-\u30ff]/g, "ja"],
	[/[\uac00-\ud7af]/g, "ko"],
	[/[\u4e00-\u9fff]/g, "zh"],
	[/[\u0600-\u06ff]/g, "ar"],
	[/[\u0e00-\u0e7f]/g, "th"],
	[/[\u0400-\u04ff]/g, "ru"],
	[/[\u0370-\u03ff]/g, "el"],
	[/[\u0590-\u05ff]/g, "he"],
];

const MIN_HITS = 6;

/** Words only one of two close languages uses; they decide when the shared ones tie. */
const DISTINCTIVE: ReadonlyArray<Readonly<Record<string, readonly string[]>>> = [
	{
		da: ["af", "blevet", "jeres", "hvad", "nogle", "efter", "beder", "venligst", "fortsætte", "vores", "ved", "også"],
		no: ["av", "blitt", "deres", "hva", "noen", "etter", "ber", "vennligst", "fortsette", "våre", "ved", "også"],
	},
];

export const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
	en: "English", de: "German", da: "Danish", no: "Norwegian", sv: "Swedish", nl: "Dutch", fr: "French", es: "Spanish",
	it: "Italian", pt: "Portuguese", pl: "Polish", tr: "Turkish", vi: "Vietnamese", id: "Indonesian", ja: "Japanese",
	ko: "Korean", zh: "Chinese", ar: "Arabic", th: "Thai", ru: "Russian", el: "Greek", he: "Hebrew",
};

export function detectLanguage(text: string): string | undefined {
	const letters = text.replace(/[^\p{L}]/gu, "").length;
	if (letters < 40) return undefined;
	// Japanese mixes kana with Chinese characters, so kana decides first.
	for (const [pattern, language] of SCRIPTS) {
		if ((text.match(pattern)?.length ?? 0) / letters > 0.3) return language;
	}
	const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
	const scores = Object.entries(STOPWORDS).map(([language, list]) => {
		const set = new Set(list);
		return { language, hits: words.filter((word) => set.has(word)).length };
	}).sort((a, b) => b.hits - a.hits);
	const [best, second] = scores;
	if (!best || best.hits < MIN_HITS) return undefined;
	const pair = second && DISTINCTIVE.find((candidate) => best.language in candidate && second.language in candidate);
	if (pair && second) {
		const count = (language: string) => {
			const set = new Set(pair[language]);
			return words.filter((word) => set.has(word)).length;
		};
		const [a, b] = [count(best.language), count(second.language)];
		if (a !== b) return a > b ? best.language : second.language;
	}
	if (second && best.hits === second.hits) return undefined;
	return best.language;
}

import type { Dossier } from "../referral/dossier";
import type { CanaryField } from "../website_types";

/** What a visitor may have typed into the campaign's pages, in the order the fake pages ask for it. */
export const visitorKinds = ["email", "password", "code", "phone", "card", "payment", "personal"] as const;
export type VisitorKind = (typeof visitorKinds)[number];

const CANARY_KIND: Record<CanaryField, VisitorKind> = {
	email: "email",
	password: "password",
	phone: "phone",
	cardNumber: "card",
	oneTimeCode: "code",
};

/**
 * Keyword rules for a field's label, in English, German, French, Spanish,
 * Italian, Portuguese and Vietnamese, matched against the label lowercased
 * and stripped of accents. Rules run in order and each match is consumed, so
 * a phrase that contains another kind's word ("email address", "postal code",
 * "codice fiscale", "username") is claimed first and never read again.
 * A rule without a kind only consumes.
 */
const RULES: ReadonlyArray<{ kind?: VisitorKind; pattern: RegExp }> = [
	// Phrases holding a word of another kind.
	{ kind: "personal", pattern: /\b(?:postal|zip|post) ?code\b|\bcode postal\b|\bcodigo postal\b|\bcodice (?:postale|fiscale)\b|\bpostleitzahl\b|\bplz\b|\bcep\b/g },
	{ kind: "phone", pattern: /\bcountry code\b|\blandervorwahl\b|\bvorwahl\b|\bindicatif\b|\bprefijo\b|\bprefisso\b/g },
	{ kind: "payment", pattern: /\biban\b|\bbic\b|\bswift\b|\b(?:account|routing|sort) (?:number|code)\b|\bkontonummer\b|\bbankleitzahl\b|\bblz\b|\bnumero de cuenta\b|\bnumero di conto\b|\bso tai khoan\b/g },
	{ kind: "code", pattern: /\bone[- ]time (?:pass(?:word|code)|code|pin)\b|\bpasscode\b|\beinmal(?:passwort|kennwort|code)\b/g },
	{ kind: "email", pattern: /\be-?mail(?:[- ]?(?:address|adresse))?\b|\badresse (?:e-?mail|electronique)\b|\b(?:direccion de )?correo(?: electronico)?\b|\bcourriel\b|\bindirizzo (?:e-?mail|di posta)\b|\bposta elettronica\b|\bendereco de e-?mail\b|\bdia chi e-?mail\b/g },
	{ pattern: /\buser ?name\b|\bbenutzername\b|\bnom d'utilisateur\b|\bnombre de usuario\b|\bnome (?:utente|de usuario)\b|\bten (?:dang nhap|nguoi dung)\b/g },
	{ kind: "card", pattern: /\b(?:credit |debit )?card(?: ?number| ?holder)?\b|\bkarten(?:nummer|inhaber)\b|\bkreditkarte\b|\bnumero de (?:carte|tarjeta|cartao)\b|\bcarte (?:bancaire|de credit)\b|\btarjeta\b|\bcartao\b|\bcarta di credito\b|\bnumero (?:della )?carta\b|\bso the\b|\bcvv2?\b|\bcvc\b|\bexpir(?:y|ation|es)\b|\bablaufdatum\b|\bgultig bis\b|\bvencimiento\b|\bscadenza\b|\bvalidade\b|\bmm ?\/ ?(?:yy|aa|jj)\b/g },
	{ kind: "password", pattern: /\bpass(?:word|wd|wort)?\b|\bpwd\b|\bkennwort\b|\bmot de passe\b|\bmdp\b|\bcontrasena\b|\bclave\b|\bsenha\b|\bparola d'ordine\b|\bmat khau\b/g },
	{ kind: "code", pattern: /\bcodes?\b|\bcodigo\b|\bcodice\b|\botp\b|\btan\b|\bpin\b|\b2fa\b|\bone[- ]time\b|\bverifi(?:cation|zierung|cacion|cacao|ca)\b|\bbestatigungs?code\b|\bsicherheitscode\b|\bma (?:xac (?:minh|nhan)|otp)\b|\bxac minh\b/g },
	{ kind: "phone", pattern: /\b(?:tele)?phone\b|\btelefon(?:nummer)?\b|\btelephone\b|\btelefono\b|\bcelular\b|\bmovil\b|\bmobil\w*|\bhandy(?:nummer)?\b|\bportable\b|\bcellulare\b|\btel\b|\bdien thoai\b|\bsdt\b/g },
	{ kind: "email", pattern: /\bmail\b|\bgmail\b|\boutlook\b/g },
	{ kind: "personal", pattern: /\b(?:full |first |last |family )?name\b|\b(?:vor|nach|familien)?name\b|\bprenom\b|\bnom\b|\bnombre\b|\bapellidos?\b|\bnome\b|\bcognome\b|\bsobrenome\b|\bho (?:va )?ten\b|\baddress\b|\badresse\b|\banschrift\b|\bstrasse\b|\bdireccion\b|\bdomicilio\b|\bindirizzo\b|\bendereco\b|\bdia chi\b|\bbirth\b|\bdob\b|\bgeburts\w*|\bnaissance\b|\bnacimiento\b|\bnascita\b|\bnascimento\b|\bngay sinh\b|\bssn\b|\bsocial security\b|\bpassport\b|\breisepass\b|\bpasseport\b|\bpasaporte\b|\bpassaporto\b|\bpassaporte\b|\b(?:personal)?ausweis\w*|\bid (?:number|card)\b|\bnational id\b|\bcarte d'identite\b|\bdni\b|\bnif\b|\bcpf\b|\brg\b|\bcccd\b|\bcmnd\b|\bcan cuoc\b|\bsteuer-?id\b|\btax id\b/g },
];

/** A label lowercased, its accents and the Vietnamese đ folded to plain letters, input controls read as words. */
function normalize(label: string): string {
	return label
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.replace(/đ/gi, "d")
		.toLowerCase()
		.replace(/ß/g, "ss")
		.replace(/[’`´]/g, "'")
		.replace(/[_[\]=]/g, " ");
}

/** What a page field's label asks for, by the rules above. */
export function fieldKinds(label: string): VisitorKind[] {
	let rest = normalize(label);
	const kinds = new Set<VisitorKind>();
	for (const rule of RULES) {
		rest = rest.replace(rule.pattern, () => {
			if (rule.kind) kinds.add(rule.kind);
			return " ";
		});
	}
	return sortKinds(kinds);
}

export function sortKinds(kinds: Iterable<VisitorKind>): VisitorKind[] {
	const set = new Set(kinds);
	return visitorKinds.filter((kind) => set.has(kind));
}

/**
 * What visitors of a campaign's pages may have typed: the synthetic values
 * our visits saw sent, the fields the reported pages label, a payment the
 * pages ask for, and what the visitor guidance adds. Never empty: a
 * payment page with nothing else recognized asks for a payment, any other
 * for a sign-in.
 */
export function campaignVisitorKinds(dossier: Pick<Dossier, "requestedFields" | "sites" | "indicators">, extra: readonly VisitorKind[] = []): VisitorKind[] {
	const kinds = new Set<VisitorKind>(extra);
	for (const field of dossier.requestedFields) {
		const kind = CANARY_KIND[field as CanaryField];
		if (kind) kinds.add(kind);
	}
	for (const site of dossier.sites) {
		for (const label of site.verdict?.fields ?? []) for (const kind of fieldKinds(label)) kinds.add(kind);
		if (site.verdict?.basis === "payment_fraud") kinds.add("payment");
	}
	if (dossier.indicators.some((indicator) => indicator.kind === "payment_receiver" && indicator.links)) kinds.add("payment");
	return kinds.size ? sortKinds(kinds) : ["email", "password"];
}

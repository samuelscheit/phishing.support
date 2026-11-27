import type { ContentMatch, ContentVerification } from "../../liveness/content";
import { serviceIdentity } from "../../network/service_identity";
import { SIGNATURE, utc } from "../host_move/notice";
import type { Recipient } from "./recipients";

/** What the escalation texts say about the reported site and our report of it. */
export type EscalationFacts = {
	domain: string;
	url: string;
	allegation: string;
	/** When the first report of the site reached a provider. */
	reportedAt: Date;
	verification: ContentVerification;
	caseUrl?: string;
	/** The site's hosting address and network, when known: "85.137.52.128 (AS43641 Sollutium-NL)". */
	hosting?: string;
	brand?: string;
};

/** The provider an oversight body is told did not act; `answer` when it answered that it would not. */
export type UnactedProvider = { role: string; name: string; email?: string; reportedAt: Date; reference?: string; answer?: "declined" | "no_threat" };

/** One match, as a sentence a reader can check with the hash. */
function matchLine(match: ContentMatch): string {
	switch (match.kind) {
		case "page_body":
			return `- ${match.url} serves the same page we captured when we reported it, byte for byte apart from its own address (SHA-256 ${match.sha256}).`;
		case "page_structure":
			return `- ${match.url} serves a page built from the same template as the one we captured when we reported it (structure SHA-256 ${match.sha256}).`;
		case "kit_file":
			return `- ${match.url} is the kit's own script, byte for byte as we captured it when we reported it (SHA-256 ${match.sha256}).`;
		case "payload":
			return `- ${match.url} hands out the same file we downloaded when we reported it (SHA-256 ${match.sha256}).`;
	}
}

/** "phishing page", "malware distribution site". */
function siteKind(allegation: string): string {
	return allegation === "malware" ? "malware distribution site" : allegation === "phishing" ? "phishing page" : "reported site";
}

/** What our check found, in lines a reader can repeat. */
export function verificationLines(verification: ContentVerification): string[] {
	const how = verification.tier === "fetch" ? "a plain request" : verification.tier === "browser" ? "a browser like the visitors'" : "a browser like the visitors' and our page analysis";
	const head = `Checked ${utc(verification.checkedAt)} with ${how}:`;
	if (verification.verdict === "served") {
		return [head, ...verification.matches.map(matchLine)];
	}
	if (verification.verdict === "changed_malicious") return [head, `- ${verification.url} has changed since our report and is still a ${verification.finding} page.`];
	return [head, `- ${verification.url}: ${verification.detail ?? verification.state}`];
}

function caseLines(facts: EscalationFacts): string[] {
	return [
		`Reported URL: ${facts.url}`,
		...(facts.hosting ? [`Hosting: ${facts.hosting}`] : []),
		...(facts.brand ? [`Impersonated brand: ${facts.brand}`] : []),
		...(facts.caseUrl ? [`Case with screenshots, captures and timestamps: ${facts.caseUrl}`] : []),
	];
}

/** To a provider that has not acted on our report: the same ticket, with proof the site still serves it. */
export function followUpNotice(params: { greeting: string; facts: EscalationFacts; reference?: string }): string {
	const { facts } = params;
	return [
		params.greeting,
		"",
		`On ${utc(facts.reportedAt.toISOString())} we reported the ${siteKind(facts.allegation)} at ${facts.url}${params.reference ? ` (your reference ${params.reference})` : ""}. We have not seen any action on it, and it is still online and still serving what we reported.`,
		"",
		...verificationLines(facts.verification),
		"",
		...caseLines(facts),
		"",
		"Please take it down, or tell us what you need from us to act on it.",
		"",
		...SIGNATURE,
	].join("\n");
}

const ANSWER: Record<NonNullable<UnactedProvider["answer"]>, string> = {
	declined: "it declined to act",
	no_threat: "it answered that it found no threat",
};

function unactedLines(providers: readonly UnactedProvider[]): string[] {
	return providers.map((provider) => `- ${provider.name} (${provider.role}${provider.email ? `, ${provider.email}` : ""}): reported ${utc(provider.reportedAt.toISOString())}${provider.reference ? `, reference ${provider.reference}` : ""}; ${provider.answer ? ANSWER[provider.answer] : "we have received no confirmation of action"}.`);
}

export type Draft = { subject: string; body: string };

/** To a national CERT of the country the site is hosted in: the providers there do not act. */
export function certDraft(params: { cert: Recipient; country: string; facts: EscalationFacts; unacted: readonly UnactedProvider[] }): Draft {
	const { facts } = params;
	return {
		subject: `Unmitigated ${siteKind(facts.allegation)} on a network registered in ${params.country}: ${facts.domain}`,
		body: [
			`Hello ${params.cert.name},`,
			"",
			`We are ${serviceIdentity.name}, a service that reports phishing and malware sites to the providers who can take them down. The ${siteKind(facts.allegation)} below is served from a network registered in ${params.country}, and the providers we reported it to have not taken it down:`,
			"",
			...unactedLines(params.unacted),
			"",
			...verificationLines(facts.verification),
			"",
			...caseLines(facts),
			"",
			"We would be grateful if you could pass it to the responsible network or help get it mitigated.",
			"",
			...SIGNATURE,
		].join("\n"),
	};
}

/** To an EU host that has not acted: a notice under Article 16 DSA, which gives it actual knowledge. */
export function dsaNoticeDraft(params: { host: UnactedProvider; facts: EscalationFacts }): Draft {
	const { facts, host } = params;
	return {
		subject: `Notice under Article 16 Regulation (EU) 2022/2065: ${siteKind(facts.allegation)} at ${facts.url} (please confirm receipt)`,
		body: [
			`Hello ${host.name},`,
			"",
			"This is a notice under Article 16 of Regulation (EU) 2022/2065 (Digital Services Act) about content you host.",
			"",
			`1. Reasons (Art. 16(2)(a)): the URL below hosts a ${siteKind(facts.allegation)}${facts.brand ? ` impersonating ${facts.brand}` : ""} that deceives visitors into handing over their credentials or payment data, or into running malware. We consider this illegal content: fraud${facts.brand ? " and an infringement of the brand's trademark" : ""}. ${facts.caseUrl ? `The evidence (screenshots, captures, timestamps) is at ${facts.caseUrl}.` : ""}`.trim(),
			...verificationLines(facts.verification).map((line) => `   ${line}`),
			`2. Exact location (Art. 16(2)(b)): ${facts.url}${facts.hosting ? `, served from ${facts.hosting}` : ""}.`,
			`3. Notifier (Art. 16(2)(c)): ${serviceIdentity.name}, ${serviceIdentity.mailbox}.`,
			"4. Statement (Art. 16(2)(d)): we confirm our bona fide belief that the information and allegations in this notice are accurate and complete.",
			"",
			`We first reported this to you on ${utc(host.reportedAt.toISOString())}${host.reference ? ` (reference ${host.reference})` : ""}. We consider this notice sufficiently substantiated to give rise to actual knowledge of the illegal content under Article 16(3). Please confirm receipt (Art. 16(4)), disable access to it expeditiously, and tell us your decision (Art. 16(5)).`,
			"",
			...SIGNATURE,
		].join("\n"),
	};
}

/** To the brand the site impersonates: its own abuse team often gets it down faster. */
export function brandDraft(params: { brand: Recipient; facts: EscalationFacts; unacted: readonly UnactedProvider[] }): Draft {
	const { facts } = params;
	return {
		subject: `Phishing site impersonating ${params.brand.name} still online: ${facts.domain}`,
		body: [
			`Hello ${params.brand.name} anti-phishing team,`,
			"",
			`The ${siteKind(facts.allegation)} below impersonates ${params.brand.name}. We reported it to the providers responsible for it, and they have not taken it down:`,
			"",
			...unactedLines(params.unacted),
			"",
			...verificationLines(facts.verification),
			"",
			...caseLines({ ...facts, brand: undefined }),
			"",
			"We are passing it on in case your own takedown process can get it removed sooner.",
			"",
			...SIGNATURE,
		].join("\n"),
	};
}

/**
 * The text of an ICANN complaint against a gTLD registrar that has not acted
 * on our report (RAA §3.18.1-2). ICANN takes it through its web form only,
 * so the operator files it there.
 */
export function icannComplaintText(params: { registrar: UnactedProvider; facts: EscalationFacts }): string {
	const { facts, registrar } = params;
	return [
		`Domain: ${facts.domain}`,
		`Registrar: ${registrar.name}${registrar.email ? ` (abuse contact ${registrar.email})` : ""}`,
		"",
		`On ${utc(registrar.reportedAt.toISOString())} we reported ${facts.domain} to the registrar's abuse contact as a ${siteKind(facts.allegation)}${registrar.reference ? ` (reference ${registrar.reference})` : ""}. ${facts.allegation === "malware" ? "Malware distribution" : "Phishing"} is DNS Abuse under RAA §3.18.1 (SAC115). ${registrar.answer ? `The registrar answered that ${registrar.answer === "declined" ? "it would not act" : "it found no threat"}` : "We have received no confirmation that the registrar acted"}, and our own check finds the domain still serving it:`,
		...verificationLines(facts.verification),
		"",
		"Under RAA §3.18.1 the registrar must take reasonable and prompt steps to investigate and respond appropriately, and under §3.18.2, with actionable evidence of DNS Abuse, promptly take appropriate mitigation action. We ask ICANN to look into whether that happened here.",
		...(facts.caseUrl ? ["", `Evidence (screenshots, captures, timestamps, our correspondence): ${facts.caseUrl}`] : []),
	].join("\n");
}

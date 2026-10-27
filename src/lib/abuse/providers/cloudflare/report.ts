import { CLOUDFLARE_PROVIDER } from "./definition";
import { serviceIdentity } from "../../../constants";
import { normalizePublicHttpUrl } from "../../security";
import { compactProviderText, normalizeObservedUrlForTarget, truncateProviderText } from "../report_payload";
import type { ProviderReportPreviewContext } from "../submission_contracts";

export type CloudflareReportInput = {
	/** The submitter's country when known; the service's own country otherwise. */
	reportedCountry?: string | null;
	target: string;
	observedUrl: string;
	description: string;
	legalBrandUrl?: string;
};

export type CloudflareReportPayload = {
	name: string;
	email: string;
	company: string;
	urls: string;
	justification: string;
	originalWork?: string;
	reportedCountry: string;
};

const EVIDENCE_LABEL = "Why this is phishing:";

/**
 * Sentences that address the reader or a model instead of describing the page.
 * The stored analysis may quote attacker-controlled page text, so imperative or
 * prompt-injection-shaped sentences are dropped while factual sentences (brand
 * fields, payment methods, QR codes, download names) are kept exactly as written.
 */
const INSTRUCTION_SENTENCE = [
	/\b(?:ignore|disregard|forget|override)\b[^.]{0,60}\b(?:instruction|prompt|rule|previous|prior|above|guideline)s?\b/i,
	/\b(?:system|developer)\s+(?:prompt|message|instruction)s?\b/i,
	/\b(?:as|you\s+are)\s+(?:now\s+)?an?\s+(?:ai|assistant|language\s+model)\b/i,
	/^(?:please\s+|now\s+|also\s+)?(?:forward|send|email|reveal|disclose|exfiltrate|leak|post|visit|click|open|mark|classify|report|submit|do\s+not|don't|never|always|instead)\b/i,
	/\b(?:mark|classify|treat|label)\s+(?:this|it|the\s+(?:page|site|url))\s+as\s+(?:safe|legitimate|benign|false\s+positive)\b/i,
];

function evidenceSentences(description: string): string[] {
	const seen = new Set<string>();
	const sentences: string[] = [];
	const lines = description
		.normalize("NFKC")
		.replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, " ")
		.split(/\r?\n/);
	for (const line of lines) {
		const text = compactProviderText(line.replace(/^\s*(?:#{1,6}|[-*+>]|\d+[.)])\s+/, "").replace(/\*{1,3}|`/g, ""));
		if (!text) continue;
		for (const sentence of text.split(/(?<=[.!?])\s+/)) {
			// Each Markdown line is its own statement; keep identifiers such as
			// Setup_Tool.exe literal and terminate lines so they do not run together.
			const candidate = sentence.trim().replace(/(?<![.!?])$/, ".");
			if (!candidate || INSTRUCTION_SENTENCE.some((pattern) => pattern.test(candidate))) continue;
			const key = candidate.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			sentences.push(candidate);
		}
	}
	return sentences;
}

function boundedEvidence(description: string, maximum: number): string | undefined {
	if (maximum <= 0) return undefined;
	let result = "";
	for (const sentence of evidenceSentences(description)) {
		const remaining = maximum - result.length - (result ? 1 : 0);
		if (remaining <= 0) break;
		if (sentence.length <= remaining) {
			result = result ? `${result} ${sentence}` : sentence;
			continue;
		}
		const partial = truncateProviderText(sentence, remaining);
		if (partial.length >= 20) result = result ? `${result} ${partial}` : partial;
		break;
	}
	return result || undefined;
}

/**
 * One builder serves both the reviewed preview and the form payload, so the
 * operator approves exactly what Cloudflare receives. The target, observed URL
 * and legal brand URL are never truncated; only the evidence body is bounded.
 */
function buildCloudflareJustification(input: { target: string; observedUrl: string; legalBrandUrl?: string; description: string }): string | undefined {
	const prefix = [
		`Confirmed phishing site: ${input.target}`,
		`Phishing URL: ${input.observedUrl}`,
		input.legalBrandUrl ? `Impersonated brand's real site: ${input.legalBrandUrl}` : undefined,
	].filter((line): line is string => Boolean(line)).join("\n");
	const evidence = boundedEvidence(input.description, CLOUDFLARE_PROVIDER.maximumJustificationLength - prefix.length - EVIDENCE_LABEL.length - 3);
	return evidence ? `${prefix}\n\n${EVIDENCE_LABEL}\n${evidence}` : undefined;
}

/** Render the exact justification the Cloudflare form will receive. */
export function buildCloudflareReportPreview(input: ProviderReportPreviewContext): string | undefined {
	const observedUrl = input.observedUrls.map((url) => normalizeObservedUrlForTarget(url, input.target)).find(Boolean);
	if (!observedUrl) return undefined;
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	if (input.legalBrandUrl && !legalBrandUrl) return undefined;
	return buildCloudflareJustification({ target: input.target, observedUrl, ...(legalBrandUrl ? { legalBrandUrl } : {}), description: input.description });
}

/** Create Cloudflare's reviewed form payload from the abuse report. */
export function buildCloudflareReportPayload(input: CloudflareReportInput): CloudflareReportPayload {
	const observedUrl = normalizeObservedUrlForTarget(input.observedUrl, input.target);
	if (!observedUrl) throw new Error("Cloudflare abuse reporting requires a valid observed URL for the target.");
	const legalBrandUrl = input.legalBrandUrl === undefined ? undefined : normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true });
	if (input.legalBrandUrl !== undefined && !legalBrandUrl) throw new Error("Cloudflare abuse reporting requires a valid legal brand URL.");
	const justification = buildCloudflareJustification({ target: input.target, observedUrl, ...(legalBrandUrl ? { legalBrandUrl } : {}), description: input.description });
	if (!justification) throw new Error("Cloudflare abuse reporting requires a non-empty report description.");

	return {
		name: serviceIdentity.name,
		email: serviceIdentity.mailbox,
		company: `${serviceIdentity.url}/`,
		urls: observedUrl,
		justification,
		...(legalBrandUrl ? { originalWork: legalBrandUrl } : {}),
		reportedCountry: /^[A-Z]{2}$/.test(input.reportedCountry ?? "") ? input.reportedCountry! : serviceIdentity.countryCode,
	};
}

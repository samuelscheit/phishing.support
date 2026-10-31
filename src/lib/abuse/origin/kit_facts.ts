import { SubmissionsEntity } from "../../db/entities";
import { describeDataEntryField, type WebsiteDataEntryField } from "../../website_types";
import { AbuseRepository } from "../repository";
import { kitCollectedData, type KitCollectedData, type OriginHostSnapshot } from "./snapshot";

/** Ordered: the first matching category wins for one field. */
const FIELD_CATEGORIES: Array<[KitCollectedData, RegExp]> = [
	["backup codes", /backup/i],
	["authenticator codes", /authenticator|totp/i],
	["recovery email", /recovery/i],
	["one-time 2FA codes", /\botp\b|one[-\s]?time|sec[-_]?code|verification[-_\s]?code|\d-digit|2fa|sms[-_\s]?code/i],
	["password", /password|passwd|\bpin\b|passcode/i],
	["payment card details", /card|\bcvv\b|\bcvc\b|expir|cc[-_]?(?:num|number|exp)/i],
	["identity details", /\bssn\b|social[-_\s]?security|birth|\bdob\b|passport|national[-_\s]?id|tax[-_\s]?id/i],
	// Sign-in boxes are commonly labelled "Email or phone"; test them before a plain phone field.
	["sign-in email or phone", /e-?mail|user(?:name)?|login|identifier|account/i],
	["phone number", /phone|mobile|\btel\b/i],
];

function fieldCategory(field: WebsiteDataEntryField): KitCollectedData | undefined {
	if (/type=hidden|type=submit|type=button/i.test(field.control)) return undefined;
	const descriptor = [field.id, field.name, field.autocomplete, field.label, field.placeholder, describeDataEntryField(field)]
		.filter(Boolean)
		.join(" ");
	if (/captcha|text you (?:hear|see)/i.test(descriptor)) return undefined;
	return FIELD_CATEGORIES.find(([, pattern]) => pattern.test(descriptor))?.[0];
}

function line(value: string, maximum: number): string {
	return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

/**
 * Summarize what the captured kit demonstrably does, from the classifier's
 * cited page fields and the controlled exfiltration probe only.
 */
export async function capturedKitFacts(submissionId: bigint): Promise<OriginHostSnapshot["kit"]> {
	const submission = await SubmissionsEntity.get(submissionId);
	const website = submission?.data.kind === "website" ? submission.data.website : undefined;
	const assessment = website?.siteAssessments?.find(({ finding }) => finding === "phishing");
	const collected = new Set(
		(website?.siteAssessments ?? [])
			.filter(({ finding }) => finding === "phishing")
			.flatMap(({ collectionFields }) => collectionFields ?? [])
			.map(fieldCategory)
			.filter((category): category is KitCollectedData => Boolean(category)),
	);
	const exfiltrationTargets: string[] = [];
	if (website?.backendProbe?.status === "completed") {
		for (const report of await AbuseRepository.listReportsForSubmission(submissionId)) {
			if (!report.idempotencyKey?.startsWith("exfil:")) continue;
			for (const target of await AbuseRepository.listTargets(report.id)) exfiltrationTargets.push(line(target.normalizedTarget, 300));
		}
	}
	const evidenceQuote = assessment?.evidenceQuote ? line(assessment.evidenceQuote, 300) : undefined;
	return {
		...(assessment?.phishingBasis ? { phishingBasis: assessment.phishingBasis } : {}),
		...(evidenceQuote ? { evidenceQuote } : {}),
		collects: kitCollectedData.filter((category) => collected.has(category)),
		exfiltrationProbed: website?.backendProbe?.status === "completed",
		exfiltrationTargets: [...new Set(exfiltrationTargets)].slice(0, 20),
	};
}

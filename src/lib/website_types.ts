export type WebsiteNavigationHop = {
	index: number;
	url: string;
	hostname: string;
	status: number | null;
	redirectTo?: string;
	contentType?: string;
	contentCaptured: boolean;
};

/**
 * A script or stylesheet, from any host, as the browser received it during capture.
 * Its hash is the HTTP response-body hash urlscan.io indexes, so it can find
 * other sites serving the identical kit file.
 */
export type WebsiteKitResource = {
	url: string;
	mimeType: string;
	size: number;
	sha256: string;
};

/** Only this explicit finding is eligible for the automatic phishing handoff. */
export type WebsiteSiteFinding = "phishing" | "benign" | "prank_or_troll" | "insufficient_evidence";

export type WebsitePhishingBasis = "credential_theft" | "payment_fraud" | "malware_delivery";

/** A captured control through which a visitor can enter data, with or without a surrounding form. */
export type WebsiteDataEntryField = {
	/** Reference assigned in document order; the classifier cites it. */
	ref: string;
	/** Element and input type, for example `input[type=text]` or `textarea`. */
	control: string;
	id?: string;
	name?: string;
	autocomplete?: string;
	label?: string;
	placeholder?: string;
};

/** The control's most human-readable descriptor. */
export function describeDataEntryField(field: WebsiteDataEntryField): string {
	return field.label ?? field.placeholder ?? field.name ?? field.id ?? field.control;
}

export type WebsiteSiteClassification = {
	finding: WebsiteSiteFinding;
	phishingBasis?: WebsitePhishingBasis;
	/** Verbatim excerpt of the captured page text, in the page's own language. */
	evidenceQuote?: string;
	/** Captured data-entry fields through which the page itself collects the data, when it has any. */
	collectionFields?: WebsiteDataEntryField[];
	/** Why the classifier's phishing claim was not corroborated by the captured page. */
	rejectedPhishingClaim?: string;
};

export type WebsiteSiteAssessment = WebsiteSiteClassification & {
	hopIndex: number;
};

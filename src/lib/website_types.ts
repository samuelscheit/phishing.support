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

/**
 * `phishing` impersonates a trusted brand to take credentials or payment;
 * `malware` gets the visitor to download, install, or run something, whether
 * or not it borrows a real brand. Only these two findings are reported.
 */
export type WebsiteSiteFinding = "phishing" | "malware" | "benign" | "prank_or_troll" | "insufficient_evidence";

/** What a confirmed phishing page takes from its visitor. */
export type WebsitePhishingBasis = "credential_theft" | "payment_fraud";

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
	/** Set only for `phishing`. */
	phishingBasis?: WebsitePhishingBasis;
	/** Verbatim excerpt of the captured page text, in the page's own language. */
	evidenceQuote?: string;
	/** Captured data-entry fields through which the page itself collects the data, when it has any. */
	collectionFields?: WebsiteDataEntryField[];
	/** Why the classifier's phishing or malware claim was not corroborated by the captured page. */
	rejectedClaim?: string;
};

export type WebsiteSiteAssessment = WebsiteSiteClassification & {
	hopIndex: number;
};

/** The two findings that are reported to providers. */
export type ReportableWebsiteFinding = { finding: "phishing"; phishingBasis: WebsitePhishingBasis } | { finding: "malware" };

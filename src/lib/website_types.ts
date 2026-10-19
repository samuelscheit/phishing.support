export type WebsiteNavigationHop = {
	index: number;
	url: string;
	hostname: string;
	status: number | null;
	redirectTo?: string;
	contentType?: string;
	contentCaptured: boolean;
};

/** Only this explicit finding is eligible for the automatic phishing handoff. */
export type WebsiteSiteFinding = "phishing" | "benign" | "prank_or_troll" | "insufficient_evidence";

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

export type WebsiteSiteClassification = {
	finding: WebsiteSiteFinding;
	phishingBasis?: WebsitePhishingBasis;
	/** Verbatim excerpt of the captured page text, in the page's own language. */
	evidenceQuote?: string;
	/** Captured data-entry fields through which the page collects the credentials or payment data. */
	collectionFields?: WebsiteDataEntryField[];
	/** Why the classifier's phishing claim was not corroborated by the captured page. */
	rejectedPhishingClaim?: string;
};

export type WebsiteSiteAssessment = WebsiteSiteClassification & {
	hopIndex: number;
};

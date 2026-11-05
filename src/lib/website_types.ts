export type WebsiteNavigationHop = {
	index: number;
	url: string;
	hostname: string;
	status: number | null;
	redirectTo?: string;
	contentType?: string;
	/**
	 * Set when the capture followed this page's own link, as a visitor would,
	 * to the next page of its flow; `redirectTo` is the page that link opened.
	 * The page was captured as an earlier step of the case.
	 */
	followedLink?: { label: string };
	/**
	 * Set when the capture entered a made-up value into this page's field, as
	 * a visitor enters their address, and submitted it; `redirectTo` is the
	 * page that then showed. The page was captured as an earlier step of the case.
	 */
	submittedField?: WebsiteSubmittedField;
	contentCaptured: boolean;
};

/** The identifier a capture entered into a page's field to reach the kit's next step. */
export type WebsiteSubmittedField = {
	/** The field as the captured page recorded it; its id or name finds it again when the visit is replayed. */
	field: WebsiteDataEntryField;
	/** The made-up value entered, a canary that can reach no one. */
	value: string;
	/**
	 * The captcha widget beside the field (Turnstile, reCAPTCHA, hCaptcha):
	 * `passed` when it issued its token before the form was submitted,
	 * `unsolved` when it never did. Absent when the form had none.
	 */
	humanCheck?: "passed" | "unsolved";
};

/** A field a live capture fills and submits; the value goes into that field only. */
export type WebsiteFieldSubmission = Pick<WebsiteSubmittedField, "field" | "value">;

/**
 * How a capture handled a page whose own script sends visitors to another site.
 * `detected`: Tor/datacenter visitors and the residential exit reached
 * different sites; the archive holds the residential one. When that is
 * another site too, it may be just another decoy (a cloaker rotating decoy
 * sites per visit), so its verdict settles the submitted case like `uniform`. `uniform`: every
 * route, including the residential exit, was sent to the same site, which the
 * archive holds; a harmless destination then means the page cloaks against all
 * of them. `unresolved`: only the decoy could be captured.
 */
export type WebsiteCloaking = { outcome: "detected" | "uniform" | "unresolved"; detail: string };

/** A link on a captured page to another page of the same site, which the capture can follow. */
export type WebsiteContinuationLink = {
	/** Reference assigned in document order; the classifier cites it. */
	ref: string;
	/** The caption a visitor clicks, when the link has one. */
	label?: string;
	/** Absolute URL the link opens. */
	url: string;
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

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
	 * Set when the capture acted on this page as a visitor would, to reach the
	 * next step of its flow: entered a made-up value into its field and
	 * submitted it, or clicked its button. `redirectTo` is the page that then
	 * showed. The page was captured as an earlier step of the case.
	 */
	performedAction?: WebsitePerformedAction;
	contentCaptured: boolean;
};

/** A button on a captured page that continues its flow; found again on the live page by its caption. */
export type WebsiteContinuationControl = {
	/** Reference assigned in document order; the classifier cites it. */
	ref: string;
	/** The caption a visitor reads on it. */
	label: string;
};

/**
 * One step a live capture takes on a page, as a visitor would: enter a value
 * into a field and submit it (the value goes into that field only), or click
 * a button.
 */
export type WebsitePageAction =
	| { kind: "fill"; field: WebsiteDataEntryField; value: string }
	| { kind: "click"; control: WebsiteContinuationControl };

/**
 * How the captcha widget beside a submitted field (Turnstile, reCAPTCHA,
 * hCaptcha) went before the form was sent: `passed` issued its token by
 * itself; `passed_after_click` did once the capture clicked its checkbox, as
 * a visitor would; `unsolved` and `unsolved_after_click` never did.
 */
export type WebsiteHumanCheck = "passed" | "passed_after_click" | "unsolved" | "unsolved_after_click";

/** Whether the widget beside the field never issued its token. */
export function humanCheckUnsolved(check: WebsiteHumanCheck | undefined): boolean {
	return check === "unsolved" || check === "unsolved_after_click";
}

/** A page action as the capture took it. */
export type WebsitePerformedAction =
	| (Extract<WebsitePageAction, { kind: "fill" }> & {
		/** The captcha widget beside the field; absent when the form had none. */
		humanCheck?: WebsiteHumanCheck;
	})
	| Extract<WebsitePageAction, { kind: "click" }>;

/** The page action without what the capture observed while taking it, for replaying the visit. */
export function pageActionOf(performed: WebsitePerformedAction): WebsitePageAction {
	return performed.kind === "fill" ? { kind: "fill", field: performed.field, value: performed.value } : performed;
}

/** How the action reads to a person: `the field "Email address"`, `the button "Confirm"`. */
export function describePageAction(action: WebsitePageAction): string {
	return action.kind === "fill" ? `the field ${JSON.stringify(describeDataEntryField(action.field))}` : `the button ${JSON.stringify(action.control.label)}`;
}

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

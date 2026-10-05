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

export type WebsiteSiteAssessment = {
	hopIndex: number;
	finding: WebsiteSiteFinding;
	evidenceQuote?: string;
};

export type WebsiteSiteClassification = {
	finding: WebsiteSiteFinding;
	evidenceQuote?: string;
};

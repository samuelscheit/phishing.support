import type { Submission } from "@/lib/db/schema";
import { truncateAtWord } from "@/lib/util/text";
import { websiteSiteName } from "@/lib/website/info/site";
import { utcDate } from "@/lib/util/date_time";

/** What a submission's page tells search engines and share cards: who it is about and what was found. */
export type SubmissionSeo = {
	/** The site or the email subject the case is about. */
	subject: string;
	/** The verdict in a few words, for the share card's badge. */
	verdict: string;
	tone: "danger" | "safe" | "pending" | "neutral";
	title: string;
	description: string;
};

const VERDICT_STATUSES = new Set<Submission["status"]>(["reported", "invalid"]);

/** Search engines show about 160 characters of a description. */
const DESCRIPTION_LENGTH = 160;

function websiteVerdict(submission: Submission): Pick<SubmissionSeo, "verdict" | "tone"> & { phrase: string } {
	const website = submission.data.kind === "website" ? submission.data.website : undefined;
	switch (submission.status) {
		case "reported": {
			const malware = website?.siteAssessments?.some((assessment) => assessment.finding === "malware");
			return malware
				? { verdict: "Confirmed malware site", tone: "danger", phrase: "is a malware site, reported for takedown" }
				: { verdict: "Confirmed phishing site", tone: "danger", phrase: "is a phishing site, reported for takedown" };
		}
		case "invalid":
			return { verdict: "No phishing found", tone: "safe", phrase: "was checked: no phishing found" };
		case "failed":
			return { verdict: "Check inconclusive", tone: "neutral", phrase: "could not be fully checked" };
		default:
			return { verdict: "Check in progress", tone: "pending", phrase: "is being checked for phishing" };
	}
}

function emailVerdict(submission: Submission): Pick<SubmissionSeo, "verdict" | "tone"> & { phrase: string } {
	switch (submission.status) {
		case "reported":
			return { verdict: "Confirmed phishing email", tone: "danger", phrase: "is a phishing email, reported to the sender's providers" };
		case "invalid":
			return { verdict: "No phishing found", tone: "safe", phrase: "was checked: no phishing found" };
		case "failed":
			return { verdict: "Check inconclusive", tone: "neutral", phrase: "could not be fully checked" };
		default:
			return { verdict: "Check in progress", tone: "pending", phrase: "is being checked for phishing" };
	}
}

/**
 * The title, description, and share-card verdict of a submission's page.
 * The title names the site or email and the verdict, as someone searching for
 * "is <site> a scam" would read it; the description adds what the analysis
 * found, in its own words.
 */
export function submissionSeo(submission: Submission): SubmissionSeo {
	const isWebsite = submission.data.kind === "website";
	const subject = isWebsite
		? websiteSiteName(submission.data.kind === "website" ? submission.data.website?.url : undefined) ?? "Website"
		: (submission.data.kind === "email" && submission.data.email?.subject?.trim()) || "Email without a subject";
	const { verdict, tone, phrase } = isWebsite ? websiteVerdict(submission) : emailVerdict(submission);
	const named = isWebsite ? subject : `The email “${truncateAtWord(subject, 70, { ellipsis: true })}”`;
	const checked = `Checked on ${utcDate(submission.createdAt)} by Phishing Support.`;
	// Only a finished verdict's text says what was found; a failure's is a technical error.
	const finding = VERDICT_STATUSES.has(submission.status) ? (submission.info ?? "") : "";
	return {
		subject,
		verdict,
		tone,
		title: isWebsite ? `Is ${subject} a scam? ${verdict}` : `“${truncateAtWord(subject, 60, { ellipsis: true })}” – ${verdict}`,
		description: truncateAtWord(`${named} ${phrase}. ${checked} ${finding}`, DESCRIPTION_LENGTH, { ellipsis: true }),
	};
}

import { SubmissionsEntity } from "@/lib/db/entities";
import { shareCard, SHARE_CARD_SIZE } from "@/lib/seo/share_card";
import { submissionSeo } from "@/lib/seo/submission";

export const alt = "Phishing check result";
export const size = SHARE_CARD_SIZE;
export const contentType = "image/png";

/** The share card of a submission: the site or email it checked, and the verdict. */
export default async function Image({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const submission = await SubmissionsEntity.get(BigInt(id)).catch(() => undefined);
	if (!submission) return shareCard({ eyebrow: "Phishing check", headline: "Submission not found" });
	const seo = submissionSeo(submission);
	return shareCard({
		eyebrow: submission.data.kind === "website" ? "Website phishing check" : "Email phishing check",
		headline: seo.subject,
		badge: { label: seo.verdict, tone: seo.tone },
	});
}

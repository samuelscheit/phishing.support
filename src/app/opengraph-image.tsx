import { shareCard, SHARE_CARD_SIZE } from "@/lib/seo/share_card";

export const alt = "Phishing Support: report phishing emails and websites for takedown";
export const size = SHARE_CARD_SIZE;
export const contentType = "image/png";

export default function Image() {
	return shareCard({ eyebrow: "Free phishing analysis and takedown reports", headline: "Report phishing emails and websites" });
}

/** How a lure misrepresents what the visitor is doing. */
export const DECEPTION_KINDS = ["fake_application", "prize_or_reward", "account_or_security_warning", "fake_verification", "other_misrepresentation"] as const;
export type DeceptionKind = (typeof DECEPTION_KINDS)[number];

export const DECEPTION_PHRASES: Readonly<Record<DeceptionKind, string>> = {
	fake_application: "a fake application for money or benefits",
	prize_or_reward: "a fake prize, reward or giveaway",
	account_or_security_warning: "a fake account, security or virus warning",
	fake_verification: "a fake verification step",
	other_misrepresentation: "a page that misrepresented what the visitor was doing",
};

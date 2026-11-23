/** How a lure misrepresents what the visitor is doing. */
export const DECEPTION_KINDS = ["fake_application", "prize_or_reward", "account_or_security_warning", "fake_verification", "other_misrepresentation"] as const;

/**
 * The kinds a report goes out for without an operator: each names a lie a
 * recipient can check against the screenshots. A misrepresentation of no
 * recognised kind is too open to judge automatically.
 */
export const REPORTED_DECEPTION_KINDS = ["fake_application", "prize_or_reward", "account_or_security_warning", "fake_verification"] as const;
export type ReportedDeceptionKind = (typeof REPORTED_DECEPTION_KINDS)[number];

export const DECEPTION_PHRASES: Readonly<Record<ReportedDeceptionKind, string>> = {
	fake_application: "a fake application for money or benefits",
	prize_or_reward: "a fake prize, reward or giveaway",
	account_or_security_warning: "a fake account, security or virus warning",
	fake_verification: "a fake verification step",
};

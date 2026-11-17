import type { AbuseProviderRoute } from "../abuse/schema";

/**
 * Route keys of a campaign's referral report. Every mail is its own route:
 * the complaint and each supplement to an authority, and each preservation
 * notice to a provider. Replies correlate to the route they answer.
 */
export const REFERRAL_ALLEGATION = "criminal_referral";

export function authorityRegistryKey(authorityId: string): string {
	return `authority:${authorityId}`;
}

export function preservationRegistryKey(recipient: string): string {
	return `preservation:${recipient.toLowerCase()}`;
}

export function isAuthorityRoute(route: Pick<AbuseProviderRoute, "providerRegistryKey">): boolean {
	return route.providerRegistryKey.startsWith("authority:");
}

export function isPreservationRoute(route: Pick<AbuseProviderRoute, "providerRegistryKey">): boolean {
	return route.providerRegistryKey.startsWith("preservation:");
}

export function authorityIdOf(route: Pick<AbuseProviderRoute, "providerRegistryKey">): string | undefined {
	return isAuthorityRoute(route) ? route.providerRegistryKey.slice("authority:".length) : undefined;
}

/** What a referral route's mail is: the first complaint, a supplement, or a preservation notice. */
export type ReferralMailKind = "complaint" | "supplement" | "preservation_notice";

export function referralMailKind(route: Pick<AbuseProviderRoute, "resolutionSnapshot">): ReferralMailKind | undefined {
	const kind = route.resolutionSnapshot?.referralMailKind;
	return kind === "complaint" || kind === "supplement" || kind === "preservation_notice" ? kind : undefined;
}

/** The campaign sites a referral mail reported, as submission ids. */
export function reportedSubmissionIds(route: Pick<AbuseProviderRoute, "resolutionSnapshot">): string[] {
	const ids = route.resolutionSnapshot?.submissionIds;
	return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

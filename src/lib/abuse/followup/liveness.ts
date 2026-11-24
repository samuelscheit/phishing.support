import { checkSite, type SiteCheckResult } from "../../liveness/check";
import { TAKEN_DOWN_STATES } from "../../liveness/schema";
import type { DecisionToolDependencies } from "./tools";

const MAX_CHECKED_URLS = 5;

/** A provider's reason that says the content is already gone: Cloudflare's `content_removed`, "no longer visible", … */
const CONTENT_GONE_REASON = /content[_\s-]?removed|no longer (?:visible|available|accessible|online|live|present|exists?)|(?:has|have|was|were) (?:been )?(?:removed|taken down|deleted)|already (?:removed|taken down)/i;

export function reasonSaysContentGone(reason: string | undefined): boolean {
	return reason !== undefined && CONTENT_GONE_REASON.test(reason);
}

/** Our own check of every URL the report names (the target's own address when it names none). */
export async function checkReportedSites(target: { normalizedTarget: string; observedUrls: readonly string[] }, dependencies: DecisionToolDependencies): Promise<SiteCheckResult[]> {
	const observed = target.observedUrls.filter((url) => /^https?:\/\//i.test(url)).slice(0, MAX_CHECKED_URLS);
	const urls = observed.length ? observed : [`https://${target.normalizedTarget}/`];
	const results = await Promise.all(urls.map(async (url) => {
		try {
			return await checkSite(url, {
				...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
				...(dependencies.assertPublicHost ? { assertPublicHost: dependencies.assertPublicHost } : {}),
				...(dependencies.signal ? { signal: dependencies.signal } : {}),
				...dependencies.liveness,
			});
		} catch (error) {
			if (dependencies.signal?.aborted) throw dependencies.signal.reason;
			return undefined;
		}
	}));
	return results.filter((result): result is SiteCheckResult => result !== undefined);
}

/** Every reported site is taken down at the registry or host: the provider's decision stands. */
export function takedownConfirmed(checks: readonly SiteCheckResult[]): boolean {
	return checks.length > 0 && checks.every((check) => TAKEN_DOWN_STATES.includes(check.state));
}

import { extractFavicon, revalidateFavicon, type FaviconDependencies, type FetchFailure } from "./extract";
import { FaviconStore, onNewFaviconDomains } from "./store";
import type { Favicon } from "./schema";

import { DAY_MS } from "../util/date_time";
/** A stored icon's source is asked again this rarely: an icon changes with a rebrand, not more often. */
export const REVALIDATE_AFTER_MS = 30 * DAY_MS;
/** A site that answered without a usable icon is asked again after this long. */
export const MISSING_RETRY_MS = 7 * DAY_MS;
/** A site or source that could not be reached is asked again sooner: the outage is likely brief. */
export const UNREACHABLE_RETRY_MS = DAY_MS;
/** One refresh fetches at most a page and five icons, ten seconds each. */
const LEASE_MS = 2 * 60_000;
const POLL_MS = 60_000;

const retryAfter = (failure: FetchFailure) => (failure === "network" ? UNREACHABLE_RETRY_MS : MISSING_RETRY_MS);
const after = (now: Date, ms: number) => new Date(now.getTime() + ms);

async function extract(domain: string, now: Date, dependencies: FaviconDependencies): Promise<void> {
	const result = await extractFavicon(domain, dependencies);
	if (result.found) await FaviconStore.recordFound(domain, result.png, result.source, now, after(now, REVALIDATE_AFTER_MS));
	else await FaviconStore.recordMissing(domain, result.failure, result.reason, now, after(now, retryAfter(result.failure)));
}

/**
 * One due domain. A stored icon is revalidated: kept (or replaced by its
 * source's new drawing) while its source answers, kept through a network
 * failure, and dropped and extracted again once its source answers with an
 * HTTP error or serves no image. A pending or missing domain is extracted.
 */
export async function refreshFavicon(entry: Favicon, now: Date, dependencies: FaviconDependencies = {}): Promise<void> {
	if (entry.status !== "found" || !entry.png || !entry.source) return extract(entry.domain, now, dependencies);
	const result = await revalidateFavicon(entry.source, entry.png, dependencies);
	switch (result.kind) {
		case "unchanged":
			return FaviconStore.recordKept(entry.domain, after(now, REVALIDATE_AFTER_MS), null);
		case "updated":
			return FaviconStore.recordFound(entry.domain, result.png, entry.source, now, after(now, REVALIDATE_AFTER_MS));
		case "unreachable":
			return FaviconStore.recordKept(entry.domain, after(now, UNREACHABLE_RETRY_MS), result.reason);
		case "gone":
			return extract(entry.domain, now, dependencies);
	}
}

/** Refresh every due domain, one after the other; returns how many. */
export async function refreshDueFavicons(options: { now?: () => Date; dependencies?: FaviconDependencies; limit?: number } = {}): Promise<number> {
	const now = options.now ?? (() => new Date());
	let refreshed = 0;
	while (refreshed < (options.limit ?? Number.POSITIVE_INFINITY)) {
		const entry = await FaviconStore.claimDue(now(), LEASE_MS);
		if (!entry) break;
		try {
			await refreshFavicon(entry, now(), options.dependencies);
		} catch (error) {
			// The lease lapses and the domain is taken up again on a later pass.
			console.error(`Favicon refresh of ${entry.domain} failed:`, error);
		}
		refreshed += 1;
	}
	return refreshed;
}

/**
 * Refresh due icons in the background: every minute, and at once when a
 * page names a domain not seen before, so its icon shows on the next load.
 * Passes never overlap. Returns the stop function.
 */
export function startFaviconRefresh(): () => void {
	let running: Promise<void> | undefined;
	let again = false;
	const pass = () => {
		if (running) {
			again = true;
			return;
		}
		running = refreshDueFavicons()
			.then(() => undefined, (error) => console.error("Favicon refresh failed:", error))
			.finally(() => {
				running = undefined;
				if (again) {
					again = false;
					pass();
				}
			});
	};
	const timer = setInterval(pass, POLL_MS);
	timer.unref?.();
	const unsubscribe = onNewFaviconDomains(pass);
	pass();
	return () => {
		clearInterval(timer);
		unsubscribe();
	};
}

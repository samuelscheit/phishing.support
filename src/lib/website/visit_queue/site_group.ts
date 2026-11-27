import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { submissions } from "@/lib/db/schema";
import { siteGroupOf } from "@/lib/network/registered_domain";

/** The site group of a website case's URL; undefined when the URL does not parse. */
export function caseSiteGroup(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return siteGroupOf(url).key;
	} catch {
		return undefined;
	}
}

/**
 * Give every website case opened before site groups were recorded its group:
 * SQLite knows no public suffix list, so the migration cannot. Runs on start;
 * a case whose URL does not parse stays without one. Returns how many it set.
 */
export async function backfillSiteGroups(): Promise<number> {
	const db = await getDb();
	const missing = db.select({ id: submissions.id, data: submissions.data }).from(submissions)
		.where(and(eq(submissions.kind, "website"), isNull(submissions.siteGroup)))
		.all();
	let set = 0;
	db.transaction((tx) => {
		for (const { id, data } of missing) {
			const group = caseSiteGroup(data.kind === "website" ? data.website.url : undefined);
			if (!group) continue;
			tx.update(submissions).set({ siteGroup: group }).where(eq(submissions.id, id)).run();
			set++;
		}
	}, { behavior: "immediate" });
	return set;
}

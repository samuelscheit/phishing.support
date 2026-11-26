"use client";

import { SiteVisitBrowser } from "@/components/SiteVisitPanel";
import { useLiveVisit } from "@/components/live_visit/useLiveVisit";

/** The real live view of a fixture visit (`visit/route.ts`): the case page's browser, its socket and console. */
export function LiveFixtureVisit({ id }: { id: string }) {
	const visit = useLiveVisit(id, true);
	return (
		<main className="mx-auto max-w-3xl p-6">
			<SiteVisitBrowser running pages={[]} live={visit} fallbackUrl="about:blank" />
		</main>
	);
}

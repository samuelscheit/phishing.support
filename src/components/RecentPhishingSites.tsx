import { formatDistanceToNow } from "date-fns";
import Link from "next/link";

import { listSubmissionItems, type SubmissionListItem } from "@/lib/submissions/list";
import { websiteSiteName } from "@/lib/website/info/site";

/** Where a tile of the list leads and what it is named by: a campaign by its domain, else its newest site. */
function siteOf(item: SubmissionListItem) {
	const newest = item.type === "submission" ? item.submission : item.newest;
	if (newest.kind !== "website") return undefined;
	const name = websiteSiteName(newest.title) ?? newest.title;
	return item.type === "campaign"
		? { key: item.key, href: `/campaigns/${item.campaignId}`, name: item.domain ?? name, createdAt: newest.createdAt }
		: { key: item.key, href: `/submissions/${newest.id}`, name: item.type === "siteGroup" ? item.siteGroup : name, createdAt: newest.createdAt };
}

/** The newest websites confirmed as phishing, one per campaign or domain, each linking to its page: real examples of what to look for. */
export async function RecentPhishingSites({ count = 12 }: { count?: number }) {
	const { items } = await listSubmissionItems({ filters: ["reported"], limit: count * 2 });
	const sites = items.flatMap((item) => siteOf(item) ?? []).slice(0, count);
	if (!sites.length) return null;
	return (
		<ul className="grid list-none! gap-2 pl-0! sm:grid-cols-2 [&_li]:mt-0!">
			{sites.map((site) => (
				<li key={site.key}>
					<Link href={site.href} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 no-underline! transition-colors hover:bg-accent">
						<span className="truncate font-mono text-sm text-foreground">{site.name}</span>
						<span className="shrink-0 text-xs text-muted-foreground">{formatDistanceToNow(new Date(site.createdAt), { addSuffix: true })}</span>
					</Link>
				</li>
			))}
		</ul>
	);
}

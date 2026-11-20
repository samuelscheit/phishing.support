import { formatDistanceToNow } from "date-fns";
import Link from "next/link";

import { listSubmissionCards } from "@/lib/submissions/list";
import { websiteSiteName } from "@/lib/website/site";

/** The newest websites confirmed as phishing, each linking to its case: real examples of what to look for. */
export async function RecentPhishingSites({ count = 12 }: { count?: number }) {
	const { submissions } = await listSubmissionCards({ filters: ["phishing"], limit: count * 3 });
	const sites = submissions.filter((card) => card.kind === "website").slice(0, count);
	if (!sites.length) return null;
	return (
		<ul className="grid list-none! gap-2 pl-0! sm:grid-cols-2 [&_li]:mt-0!">
			{sites.map((card) => (
				<li key={card.id}>
					<Link href={`/submissions/${card.id}`} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 no-underline! transition-colors hover:bg-accent">
						<span className="truncate font-mono text-sm text-foreground">{websiteSiteName(card.title) ?? card.title}</span>
						<span className="shrink-0 text-xs text-muted-foreground">{formatDistanceToNow(new Date(card.createdAt), { addSuffix: true })}</span>
					</Link>
				</li>
			))}
		</ul>
	);
}

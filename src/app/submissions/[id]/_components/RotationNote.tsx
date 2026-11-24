import type { WebsiteRotation } from "@/lib/website/types";
import { routeLabel, visitorLabel } from "./helpers";

/** A route's name as a link that shows it. */
function RouteLink({ route, onSelect }: { route: number; onSelect: (route: number) => void }) {
	return <button type="button" onClick={() => onSelect(route)} className="font-medium text-primary hover:underline">{routeLabel(route).toLowerCase()}</button>;
}

/**
 * The evidence that the link rotates: each visit the case made after its first
 * walk to sample the link's other offers, when and as whom it came, and what it
 * showed: a route not seen before, a route seen already (with the chain that
 * reached it, which proves the repeat), or its failure; then why sampling stopped.
 */
export function RotationNote({ rotation, onSelect }: { rotation: WebsiteRotation; onSelect: (route: number) => void }) {
	const count = rotation.visits.length;
	return (
		<section aria-labelledby="rotation-heading" className="rounded border bg-muted/30 p-3 text-xs">
			<h3 id="rotation-heading" className="font-medium">Rotation sampled with {count} more visit{count === 1 ? "" : "s"}</h3>
			<p className="mt-0.5 text-muted-foreground">After the first walk the case opened the submitted link again, as other visitors, to find the offers it rotates to.</p>
			<ol className="mt-2 space-y-1.5">
				{rotation.visits.map((visit, index) => (
					<li key={`${index}:${visit.startedAt}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
						<time dateTime={visit.startedAt} className="tabular-nums text-muted-foreground">{visit.startedAt.slice(11, 19)} UTC</time>
						{"repeatOf" in visit ? (
							// The whole line opens the chain that reached the route again: the proof it was a repeat.
							<details className="min-w-0">
								<summary className="cursor-pointer">
									{visitorLabel(visit.visitor)}<span className="text-muted-foreground"> — </span>showed {routeLabel(visit.repeatOf).toLowerCase()} again
									<span className="text-muted-foreground"> · {visit.hops.length} response{visit.hops.length === 1 ? "" : "s"}</span>
								</summary>
								<ol className="mt-1 space-y-0.5 border-l pl-2">
									{visit.hops.map((hop) => (
										<li key={`${hop.index}:${hop.url}`} className="break-all font-mono text-muted-foreground">
											<span className="tabular-nums">{hop.status ?? "—"}</span> {hop.url}
										</li>
									))}
								</ol>
							</details>
						) : (
							<div className="min-w-0 [overflow-wrap:anywhere]">
								{visitorLabel(visit.visitor)}<span className="text-muted-foreground"> — </span>
								{"route" in visit ? (
									<>showed a new route, <RouteLink route={visit.route} onSelect={onSelect} /></>
								) : (
									<span className="text-amber-700 dark:text-amber-400">failed: {visit.error}</span>
								)}
							</div>
						)}
					</li>
				))}
			</ol>
			<p className="mt-2 text-muted-foreground">Sampling ended: {rotation.ended}</p>
		</section>
	);
}

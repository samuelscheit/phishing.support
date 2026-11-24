import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { WebsiteRoute } from "@/lib/website/types";
import { websiteSite } from "@/lib/website/info/site";
import { routeNames } from "@/lib/website/visit/capture_files";
import { routeHasFinding, routeLabel, visitorLabel } from "./helpers";

/** Where a route ended: the site of the last page it showed. */
function routeEnd(route: WebsiteRoute): string | undefined {
	const last = route.hops.findLast((hop) => hop.contentCaptured) ?? route.hops.at(-1);
	return last ? websiteSite(last.url) : undefined;
}

/**
 * The routes a rotating link took, as segmented tabs named by the site each
 * went through; a dot marks a route that found something reportable. The
 * picked route is the one the page browser, the navigation and the visit show,
 * so the caption under the tabs says how that walk opened the link and where
 * it ended.
 */
export function RouteSelector({ routes, selected, submittedSite, onSelect }: { routes: readonly WebsiteRoute[]; selected: number; submittedSite: string | null; onSelect: (route: number) => void }) {
	const shown = routes[selected]!;
	const end = routeEnd(shown);
	const names = routeNames(routes.map(({ hops }) => hops), submittedSite);
	return (
		<section aria-labelledby="routes-heading" className="space-y-2">
			<div>
				<h2 id="routes-heading" className="text-sm font-semibold">This link rotates: {routes.length} routes</h2>
				<p className="text-xs text-muted-foreground">The submitted link sent its visits to different offers. Each route is one walk of it, with its own pages and verdicts.</p>
			</div>
			<Tabs value={String(selected)} onValueChange={(value) => onSelect(Number(value))}>
				<TabsList aria-label="Routes" className="no-scrollbar h-auto max-w-full justify-start overflow-x-auto">
					{routes.map((route, index) => {
						const via = names[index];
						return (
							<TabsTrigger key={index} value={String(index)} title={via ? `${routeLabel(index)} via ${via}` : routeLabel(index)} className="max-w-72 shrink-0 gap-1.5">
								{routeHasFinding(route) ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-hidden /> : null}
								<span className="truncate">{routeLabel(index)}{via ? <span className="font-normal text-muted-foreground"> · via {via}</span> : null}</span>
							</TabsTrigger>
						);
					})}
				</TabsList>
			</Tabs>
			<div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
				<p><span className="font-medium text-foreground">{routeLabel(selected)} of {routes.length}</span>{end ? <> ended at <span className="font-mono">{end}</span></> : null}</p>
				{shown.visitor ? <p>Opened as {visitorLabel(shown.visitor)}</p> : null}
			</div>
		</section>
	);
}

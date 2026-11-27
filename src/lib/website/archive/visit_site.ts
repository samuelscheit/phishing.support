import { FABRIC_EGRESS_LABEL, type FabricEgress } from "../../browser/fabric";
import { confirmHostNxdomain, isTunnelConnectionFailure } from "../../network/dead_dns";
import { errorText } from "../../util/error_text";
import { withBrowserBackoff } from "../analysis/failure";
import { scriptDestinationSite, WEBSITE_CAPTURE_EGRESS } from "./cloaking";
import { WebsiteCaptureFailedError, WebsiteHostOfflineError, WebsiteUnreachableError } from "./errors";
import { openLivePage, type LivePage } from "./live_page";
import type { SiteVisit, SiteVisitDependencies, SiteVisitOptions } from "./types";

/** How much of a route's failure the live view says. */
const SHORT_REASON_CHARS = 80;

/**
 * Visit a site as its victim would, in one browser from start to end: load
 * the page over the first route that reaches it (in the order of
 * WEBSITE_CAPTURE_EGRESS, or `egress` alone), capture its first page, let
 * `walk` decide from that page whether the visiting agent walks on in the
 * same browser and tab, then close the browser, whatever happened.
 *
 * A scripted jump to another site is recorded as cloaking: from the
 * residential exit it is where the page sends victims, and the case's
 * verdict on that chain settles it; from Tor or the server IP it may be a
 * decoy only the residential exit could tell apart, which is never walked.
 * A host every route failed to open a tunnel to, and that public DNS says
 * does not exist, is offline (`WebsiteHostOfflineError`): no retry changes it.
 * A browser-service failure is retried after each of `backoffMs`.
 */
export async function visitSite(options: SiteVisitOptions, dependencies: SiteVisitDependencies = {}): Promise<SiteVisit> {
	const { signal } = options;
	const live = await withBrowserBackoff(() => openReachable(options, dependencies), options.backoffMs ?? [], signal);
	try {
		const { initial } = live;
		const walk = await options.walk?.(initial);
		if (!walk || initial.cloaking?.outcome === "unresolved") return { initial };
		signal?.throwIfAborted();
		return { initial, recording: await live.walk({ ...walk, ...(options.control ? { control: options.control } : {}), ...(signal ? { signal } : {}) }) };
	} finally {
		await live.close().catch((error: unknown) => console.warn(`Closing the browser of the visit to ${options.url} failed: ${errorText(error)}`));
	}
}

/** The site's first page over the first route that reaches it, with its browser open. */
async function openReachable(options: SiteVisitOptions, dependencies: SiteVisitDependencies): Promise<LivePage> {
	const { url, control, signal } = options;
	const routes = options.egress ? [options.egress] : WEBSITE_CAPTURE_EGRESS;
	const failures: WebsiteUnreachableError[] = [];
	for (const [position, egress] of routes.entries()) {
		signal?.throwIfAborted();
		const next = routes[position + 1];
		let unreachable: WebsiteUnreachableError | undefined;
		let live: LivePage;
		try {
			live = await openLivePage(options, egress, dependencies, async (error) => {
				if (signal?.aborted) {
					await control?.watchTab(undefined);
					return;
				}
				unreachable = unreachableReason(error, egress, routes.length > 1);
				// The failed route's last frame goes from the live view before its browser closes.
				const short = errorText(unreachable?.reason ?? error).slice(0, SHORT_REASON_CHARS);
				await control?.watchTab(undefined, `${capitalize(FABRIC_EGRESS_LABEL[egress])} failed (${short})${unreachable && next ? `, trying ${FABRIC_EGRESS_LABEL[next]}…` : "."}`);
			});
		} catch (error) {
			signal?.throwIfAborted();
			if (!unreachable) throw error;
			console.warn(`Visiting ${url} failed: ${unreachable.message}`);
			failures.push(unreachable);
			continue;
		}
		const site = options.egress ? undefined : scriptDestinationSite(live.initial);
		if (site) {
			// One route alone cannot tell a decoy from the site's real destination: where it goes is the page.
			const route = FABRIC_EGRESS_LABEL[egress];
			console.warn(`Visiting ${url} via ${route}: the page sent the visitor to ${site} by script`);
			live.initial = {
				...live.initial,
				cloaking: egress === "residential"
					? { outcome: "scripted", detail: `${url} sent the ${route} to ${site} by script` }
					: { outcome: "unresolved", detail: `${url} sent the ${route} to ${site} by script; ${failures.map(({ message }) => message).join("; ")}` },
			};
		}
		return live;
	}
	// A host every route failed to open a tunnel to (ignoring a residential exit outage) may be gone from DNS: public DNS settles it.
	const { hostname } = new URL(url);
	const allTunnelOrResidentialDown = failures.some(isTunnelConnectionFailure)
		&& failures.every((failure) => isTunnelConnectionFailure(failure) || failure.egress === "residential");
	if (allTunnelOrResidentialDown && await (dependencies.confirmHostNxdomain ?? confirmHostNxdomain)(hostname, signal ? { signal } : {})) {
		throw new WebsiteHostOfflineError(hostname, { cause: new WebsiteCaptureFailedError(failures) });
	}
	throw new WebsiteCaptureFailedError(failures);
}

/**
 * Why a route could not reach the site, when the next route may: the page
 * did not load, or, among several routes, the residential exit failed at
 * all (it depends on the operator's machine being online). Anything else is
 * not the route's failure and ends the visit.
 */
function unreachableReason(error: unknown, egress: FabricEgress, fallback: boolean): WebsiteUnreachableError | undefined {
	if (error instanceof WebsiteUnreachableError) return error;
	return fallback && egress === "residential" ? new WebsiteUnreachableError(egress, errorText(error)) : undefined;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

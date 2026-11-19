import { FABRIC_EGRESS_LABEL, type FabricEgress } from "../browser/fabric";
import { errorText } from "../error_text";
import { WebsiteCaptureFailedError, WebsiteUnreachableError } from "./errors";
import { openLiveCapture, type LiveCapture } from "./live_capture";
import { archiveMhtmlSnapshot } from "./mhtml";
import { scriptDestinationSite, siteOf, WEBSITE_CAPTURE_EGRESS, WEBSITE_CLOAKING_EGRESS } from "./cloaking";
import type { ArchiveWebsiteOptions, WebsiteArchiveDependencies, WebsiteArchiveResult } from "./types";

/**
 * Capture the page over the first route that reaches it and, when its script
 * sends Tor and datacenter visitors to another site, once more from the
 * residential exit. With `keepSession`, the browser of the capture returned
 * stays open as its `session`, and the caller closes it; every other capture's
 * browser is closed here.
 */
export async function archiveWebsite(options: ArchiveWebsiteOptions, dependencies: WebsiteArchiveDependencies = {}): Promise<WebsiteArchiveResult> {
	const { url, mhtmlSnapshot } = options;
	console.log(`Archiving website ${url}`);
	if (mhtmlSnapshot?.byteLength) {
		return archiveMhtmlSnapshot({ ...options, mhtmlSnapshot });
	}

	const opened: LiveCapture[] = [];
	const capture = async (egress: FabricEgress) => {
		const live = await openLiveCapture(options, egress, dependencies);
		opened.push(live);
		return live.archive;
	};
	let returned: WebsiteArchiveResult | undefined;
	const keep = (archive: WebsiteArchiveResult, result: WebsiteArchiveResult = archive): WebsiteArchiveResult => {
		const session = opened.find((live) => live.archive === archive)?.session;
		returned = archive;
		return options.keepSession && session ? { ...result, session } : result;
	};
	try {
		if (options.egress) {
			// One route, no fallbacks. A single route cannot tell a decoy from the site's
			// real destination; like the cloaking check, where it goes is taken as the page.
			try {
				return keep(await capture(options.egress));
			} catch (error) {
				if (error instanceof WebsiteUnreachableError) throw new WebsiteCaptureFailedError([error]);
				throw error;
			}
		}
		const failures: WebsiteUnreachableError[] = [];
		let decoy: { archive: WebsiteArchiveResult; site: string; egress: FabricEgress } | undefined;
		for (const egress of WEBSITE_CAPTURE_EGRESS) {
			try {
				const archive = await capture(egress);
				const site = scriptDestinationSite(archive);
				if (!site) return keep(archive);
				console.warn(`Website capture of ${url} via ${FABRIC_EGRESS_LABEL[egress]}: the page sent the visitor to ${site} by script`);
				decoy = { archive, site, egress };
				break;
			} catch (error) {
				if (!(error instanceof WebsiteUnreachableError)) throw error;
				console.warn(`Website capture of ${url} failed: ${error.message}`);
				failures.push(error);
			}
		}

		// A scripted jump to another site, or no page at all, is how cloakers answer
		// Tor and datacenter visitors. Ask once more as a residential visitor would.
		let residential: WebsiteArchiveResult | undefined;
		try {
			residential = await capture(WEBSITE_CLOAKING_EGRESS);
		} catch (error) {
			// The residential exit depends on the operator's machine being online; its
			// failure must not hide what the other routes captured.
			const reason = error instanceof WebsiteUnreachableError ? error : new WebsiteUnreachableError(WEBSITE_CLOAKING_EGRESS, errorText(error));
			console.warn(`Website capture of ${url} failed: ${reason.message}`);
			failures.push(reason);
		}

		if (residential) {
			const residentialSite = scriptDestinationSite(residential);
			// The same scripted destination for every route is either an ordinary
			// redirect or a cloaker that turns all of them away; the destination's
			// own verdict tells them apart.
			if (decoy && residentialSite === decoy.site) {
				return keep(decoy.archive, {
					...decoy.archive,
					cloaking: {
						outcome: "uniform",
						detail: `${url} sent both the ${FABRIC_EGRESS_LABEL[decoy.egress]} and the ${FABRIC_EGRESS_LABEL[WEBSITE_CLOAKING_EGRESS]} to ${decoy.site} by script`,
					},
				});
			}
			if (!decoy) return keep(residential);
			const reached = residentialSite ?? siteOf(residential.url);
			return keep(residential, {
				...residential,
				cloaking: {
					outcome: "detected",
					detail: `${url} sent the ${FABRIC_EGRESS_LABEL[decoy.egress]} to ${decoy.site} but the ${FABRIC_EGRESS_LABEL[WEBSITE_CLOAKING_EGRESS]} to ${reached}`,
				},
			});
		}
		if (decoy) {
			return keep(decoy.archive, {
				...decoy.archive,
				cloaking: {
					outcome: "unresolved",
					detail: `${url} sent the ${FABRIC_EGRESS_LABEL[decoy.egress]} to ${decoy.site} by script; the ${FABRIC_EGRESS_LABEL[WEBSITE_CLOAKING_EGRESS]} capture failed: ${failures.at(-1)?.message ?? "unavailable"}`,
				},
			});
		}
		throw new WebsiteCaptureFailedError(failures);
	} finally {
		for (const live of opened) {
			if (!options.keepSession || live.archive !== returned) await live.session.close();
		}
	}
}

import { FABRIC_EGRESS_LABEL, type FabricEgress } from "../../browser/fabric";
import { errorText } from "../../util/error_text";
import { WebsiteCaptureFailedError, WebsiteUnreachableError } from "./errors";
import { openLiveCapture, type LiveCapture } from "./live_capture";
import { archiveMhtmlSnapshot } from "./mhtml";
import { scriptDestinationSite, WEBSITE_CAPTURE_EGRESS } from "./cloaking";
import type { ArchiveWebsiteOptions, WebsiteArchiveDependencies, WebsiteArchiveResult } from "./types";

/**
 * Capture the page over the first route that reaches it, in the order of
 * WEBSITE_CAPTURE_EGRESS. A scripted jump to another site is recorded as
 * cloaking: from the residential exit it is where the page sends victims, and
 * the case's verdict on that chain settles it; from Tor or the server IP it may
 * be a decoy only the residential exit could tell apart. With `keepSession`, the browser of the capture returned
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
		for (const egress of WEBSITE_CAPTURE_EGRESS) {
			let archive: WebsiteArchiveResult;
			try {
				archive = await capture(egress);
			} catch (error) {
				// The residential exit depends on the operator's machine being online; its
				// failure falls through to the next route like any unreachable one.
				const reason = error instanceof WebsiteUnreachableError ? error : egress === "residential" ? new WebsiteUnreachableError(egress, errorText(error)) : undefined;
				if (!reason) throw error;
				console.warn(`Website capture of ${url} failed: ${reason.message}`);
				failures.push(reason);
				continue;
			}
			const site = scriptDestinationSite(archive);
			if (!site) return keep(archive);
			const route = FABRIC_EGRESS_LABEL[egress];
			console.warn(`Website capture of ${url} via ${route}: the page sent the visitor to ${site} by script`);
			return keep(archive, {
				...archive,
				cloaking: egress === "residential"
					? { outcome: "scripted", detail: `${url} sent the ${route} to ${site} by script` }
					: { outcome: "unresolved", detail: `${url} sent the ${route} to ${site} by script; ${failures.map(({ message }) => message).join("; ")}` },
			});
		}
		throw new WebsiteCaptureFailedError(failures);
	} finally {
		for (const live of opened) {
			if (!options.keepSession || live.archive !== returned) await live.session.close();
		}
	}
}

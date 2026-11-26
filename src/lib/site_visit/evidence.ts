import type { ClipboardWrite } from "../browser/clipboard";
import { matchedCanaries } from "../exfiltration/analysis";
import type { CapturedNetworkRequest, ExfiltrationCanaries } from "../exfiltration/types";
import type { DownloadedFile } from "../website/visit/download";
import { isSameWebsite } from "../website/info/site";
import type { CanaryField, VisitDataSent, WebsiteNavigationHop } from "../website/types";
import type { SiteVisitRecording } from "./visit";

/**
 * A visit's recording as evidence: the pages in the order the visitor saw
 * them, and for each page what it sent off, made the visitor download, and
 * put on the clipboard while it was shown. A page is shown from its snapshot
 * until the next one, so the request a form sends on submit belongs to the
 * page with the form. The captured page is shown from its capture on: what
 * it copied before the visit began (a verification the capture clicked) is
 * its own.
 */

const CANARY_FIELDS: readonly CanaryField[] = ["email", "password", "phone", "cardNumber", "oneTimeCode"];


export type VisitPage<Archive> = {
	archive: Archive;
	shownFrom: Date;
	shownUntil?: Date;
	dataSent: VisitDataSent[];
	downloads: DownloadedFile[];
	clipboardWrites: ClipboardWrite[];
};

type PageArchive = { url: string; navigationHops: WebsiteNavigationHop[] };

/** The synthetic values one request carried, by name. */
function sentFields(request: CapturedNetworkRequest, canaries: ExfiltrationCanaries): CanaryField[] {
	const matched = new Set(matchedCanaries(request, canaries));
	return CANARY_FIELDS.filter((field) => matched.has(field));
}

/** The captured page, then each page the visit reached, with what each sent, delivered, and copied. */
export function visitPages<Archive extends PageArchive>(first: Archive, recording: Pick<SiteVisitRecording<Archive>, "startedAt" | "steps" | "requests" | "downloads" | "clipboardWrites">, canaries: ExfiltrationCanaries): VisitPage<Archive>[] {
	const shown = [{ archive: first, from: recording.startedAt }, ...recording.steps.map(({ step, observedAt }) => ({ archive: step, from: observedAt }))];
	return shown.map(({ archive, from }, index) => {
		const until = shown[index + 1]?.from;
		// The captured page was shown before the visit began.
		const within = (at: Date) => (index === 0 || at >= from) && (!until || at < until);
		const dataSent = recording.requests.flatMap((request): VisitDataSent[] => {
			if (!within(new Date(request.timestamp))) return [];
			const fields = sentFields(request, canaries);
			return fields.length ? [{ url: request.url, method: request.method, fields, sameSite: isSameWebsite(request.url, archive.url) }] : [];
		});
		return {
			archive,
			shownFrom: from,
			...(until ? { shownUntil: until } : {}),
			dataSent,
			downloads: recording.downloads.filter((file) => within(file.observedAt)),
			clipboardWrites: recording.clipboardWrites.filter((write) => within(new Date(write.at))),
		};
	});
}

/**
 * The navigation of the whole visit: each page the visitor moved on from
 * stays as a step that led on, marked with the synthetic values it sent,
 * then the hops of the page it reached.
 */
export function visitNavigation(pages: ReadonlyArray<VisitPage<PageArchive>>): WebsiteNavigationHop[] {
	return pages.flatMap((page, position) => {
		const next = pages[position + 1];
		if (!next) return page.archive.navigationHops;
		const submitted = CANARY_FIELDS.filter((field) => page.dataSent.some((sent) => sent.fields.includes(field)));
		return page.archive.navigationHops.map((hop) => (hop.contentCaptured
			? { ...hop, contentCaptured: false, redirectTo: next.archive.navigationHops[0]?.url ?? next.archive.url, visitorStep: { submitted } }
			: hop));
	}).map((hop, index) => ({ ...hop, index }));
}

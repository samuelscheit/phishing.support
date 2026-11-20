import type { WebsiteNavigationHop } from "./types";
import { SubmissionsEntity } from "../db/entities/submissions";
import { websiteSubmissionDedupeKey } from "../submissions/website";

/** A running website submission, as the flow tests start every analysis. */
export async function websiteSubmission(id: bigint, url: string) {
	return SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url } }, dedupeKey: websiteSubmissionDedupeKey(url), status: "running", source: url });
}

/** The submission once its status is one of `statuses`; throws after two seconds. */
export async function waitForStatus(id: bigint, statuses: string[]) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const submission = await SubmissionsEntity.get(id);
		if (submission && statuses.includes(submission.status)) return submission;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Submission ${id} did not reach ${statuses.join("/")}.`);
}

/** A navigation hop of a captured visit: a 200 HTML page that was not captured, unless `extra` says otherwise. */
export const navigationHop = (index: number, url: string, extra: Partial<WebsiteNavigationHop> = {}): WebsiteNavigationHop => ({ index, url, hostname: new URL(url).hostname, status: 200, contentType: "text/html", contentCaptured: false, ...extra });

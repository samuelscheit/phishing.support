import { SubmissionsEntity } from "@/lib/db/entities";
import { generateId } from "@/lib/db/ids";
import { analyzeWebsite } from "@/lib/website_ai";
import type { ReporterMetadata } from "@/lib/request_metadata";

export type WebsiteSubmissionOptions = ReporterMetadata & {
	mhtmlSnapshot?: Buffer;
	url: string;
	source?: string;
};

export async function createWebsiteSubmission(options: WebsiteSubmissionOptions): Promise<bigint> {
	const streamId = generateId();
	const { url, source } = options;

	const existingId = await SubmissionsEntity.create({
		kind: "website",
		data: { kind: "website", website: { url } },
		dedupeKey: `website-${new URL(url).hostname}`,
		status: "new",
		source: source || url,
		reporterIp: options.reporterIp,
		reporterCountry: options.reporterCountry,
		reporterHeaders: options.reporterHeaders,
		id: streamId,
	});

	if (existingId !== streamId) return existingId;

	analyzeWebsite({ submissionId: streamId, ...options }).catch(console.error);

	return streamId;
}

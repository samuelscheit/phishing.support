import { SubmissionsEntity } from "@/lib/db/entities";
import { generateId } from "@/lib/db/ids";
import { analyzeWebsite } from "@/lib/website_ai";

export type WebsiteSubmissionOptions = {
	mhtmlSnapshot?: Buffer;
	url: string;
	country_code?: string;
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
		id: streamId,
	});

	if (existingId !== streamId) return existingId;

	analyzeWebsite({ submissionId: streamId, ...options }).catch(console.error);

	return streamId;
}

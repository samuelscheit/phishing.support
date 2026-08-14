import { createHash } from "node:crypto";

import { SubmissionsEntity } from "@/lib/db/entities";
import { generateId } from "@/lib/db/ids";
import { analyzeMail } from "@/lib/mail_ai";
import type { ReporterMetadata } from "@/lib/request_metadata";

export type EmailSubmissionOptions = ReporterMetadata & {
	source?: string;
};

/** One exact source message is idempotent; unrelated mail from the same sender is not. */
export function emailSubmissionDedupeKey(emlContent: string): string {
	return `email:${createHash("sha256").update(emlContent, "utf-8").digest("hex")}`;
}

export async function createEmailSubmissionFromEml(emlContent: string, options: EmailSubmissionOptions = {}): Promise<bigint> {
	const streamId = generateId();

	const existingId = await SubmissionsEntity.create({
		kind: "email",
		data: { kind: "email" },
		dedupeKey: emailSubmissionDedupeKey(emlContent),
		id: streamId,
		source: options.source,
		reporterIp: options.reporterIp,
		reporterCountry: options.reporterCountry,
		reporterHeaders: options.reporterHeaders,
	});

	if (existingId !== streamId) return existingId;

	analyzeMail(emlContent, streamId).catch(console.error);

	return streamId;
}

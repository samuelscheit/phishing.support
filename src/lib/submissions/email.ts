import { SubmissionsEntity } from "@/lib/db/entities";
import { generateId } from "@/lib/db/ids";
import { getAddressesText } from "@/lib/mail";
import { analyzeMail } from "@/lib/mail_ai";
import { simpleParser } from "mailparser";
import type { ReporterMetadata } from "@/lib/request_metadata";

export type EmailSubmissionOptions = ReporterMetadata & {
	source?: string;
};

export async function createEmailSubmissionFromEml(emlContent: string, options: EmailSubmissionOptions = {}): Promise<bigint> {
	const streamId = generateId();
	const parsedMail = await simpleParser(emlContent, { skipTextToHtml: true });
	const from = getAddressesText(parsedMail.from);

	const existingId = await SubmissionsEntity.create({
		kind: "email",
		data: { kind: "email" },
		dedupeKey: `email-${from}`,
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

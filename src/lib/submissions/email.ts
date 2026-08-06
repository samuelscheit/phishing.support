import { SubmissionsEntity } from "@/lib/db/entities";
import { generateId } from "@/lib/db/ids";
import { getAddressesText } from "@/lib/mail";
import { analyzeMail } from "@/lib/mail_ai";
import { simpleParser } from "mailparser";

export async function createEmailSubmissionFromEml(emlContent: string, source?: string): Promise<bigint> {
	const streamId = generateId();
	const parsedMail = await simpleParser(emlContent, { skipTextToHtml: true });
	const from = getAddressesText(parsedMail.from);

	const existingId = await SubmissionsEntity.create({
		kind: "email",
		data: { kind: "email" },
		dedupeKey: `email-${from}`,
		id: streamId,
		source,
	});

	if (existingId !== streamId) return existingId;

	analyzeMail(emlContent, streamId).catch(console.error);

	return streamId;
}

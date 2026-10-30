import { normalizeMailbox } from "../mail/shared";
import { AbuseRepository } from "../repository";
import type { AbuseMailMessage, AbuseProviderRoute } from "../schema";

const HOST_MARKER = /\bthe host for the reported domain is\s*:/i;
const BLOCK_END = /\b(?:you may use this information|to respond to this issue|below is the report we received)\b/i;
const MAILBOX_IN_TEXT = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?/gi;

export type CloudflareOriginDisclosure = {
	recipient: string;
	providerLabel?: string;
};

/**
 * Read only Cloudflare's explicit host-disclosure block. Other addresses in
 * the reply (including Cloudflare's own reply mailbox) are not hosting proof.
 */
export function parseCloudflareOriginDisclosure(body: string | null | undefined): CloudflareOriginDisclosure | undefined {
	if (!body || body.length > 500_000) return undefined;
	const marker = HOST_MARKER.exec(body);
	if (!marker) return undefined;
	const remainder = body.slice(marker.index + marker[0].length, marker.index + marker[0].length + 2_000);
	const end = BLOCK_END.exec(remainder);
	const block = remainder.slice(0, end?.index ?? remainder.length);
	const recipient = (block.match(MAILBOX_IN_TEXT) ?? [])
		.map(normalizeMailbox)
		.find((mailbox): mailbox is string => Boolean(mailbox && !mailbox.endsWith("@cloudflare.com")));
	if (!recipient) return undefined;

	const providerLabel = block
		.split(/\r?\n/)
		.map((line) => line.replace(MAILBOX_IN_TEXT, "").replace(/^[\s:;,-]+|[\s:;,-]+$/g, "").trim())
		.find((line) => line.length >= 2 && line.length <= 160);
	return { recipient, ...(providerLabel ? { providerLabel } : {}) };
}

async function enqueueMessage(message: Pick<AbuseMailMessage, "id" | "reportId" | "textBody">): Promise<boolean> {
	if (!parseCloudflareOriginDisclosure(message.textBody)) return false;
	await AbuseRepository.enqueueJobOnce({
		jobType: "report_origin_host",
		reportId: message.reportId,
		payload: { messageId: message.id.toString() },
		dedupeKey: `origin-host-disclosure:${message.id.toString()}`,
	});
	return true;
}

/** Queue follow-up only for newly persisted Cloudflare messages. */
export async function enqueueOriginHostDisclosures(
	route: Pick<AbuseProviderRoute, "providerRegistryKey">,
	messages: Array<Pick<AbuseMailMessage, "id" | "reportId" | "textBody">>,
): Promise<number> {
	if (route.providerRegistryKey !== "cloudflare") return 0;
	let queued = 0;
	for (const message of messages) if (await enqueueMessage(message)) queued++;
	return queued;
}

/** Recover disclosures recorded before this worker version or immediately before a restart. */
export async function ensureOriginHostDisclosureJobs(): Promise<number> {
	let queued = 0;
	for (const message of await AbuseRepository.listProviderCorrespondence("cloudflare")) {
		if (await enqueueMessage(message)) queued++;
	}
	return queued;
}

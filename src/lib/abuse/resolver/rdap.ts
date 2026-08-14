import { isIP } from "node:net";

import { isPublicIp, normalizeDomain } from "../security";
import { asArray, asRecord, normalizeMailbox, text, uniqueStrings } from "./records";
import type { AbuseMailbox, JsonRecord } from "./types";

function vcardValues(entity: JsonRecord): JsonRecord {
	const card = asArray(entity.vcardArray);
	if (card[0] !== "vcard" || !Array.isArray(card[1])) return {};
	const result: JsonRecord = {};
	for (const item of card[1] as unknown[]) {
		const entry = asArray(item);
		const key = text(entry[0])?.toLowerCase();
		if (!key) continue;
		const value = entry[3];
		const existing = result[key];
		if (existing === undefined) result[key] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else result[key] = [existing, value];
	}
	return result;
}

function scalarStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => scalarStrings(item));
}

function entityRoles(entity: JsonRecord): string[] {
	return asArray(entity.roles)
		.map((role) => text(role)?.toLowerCase())
		.filter((role): role is string => Boolean(role));
}

function entityDisplayName(entity: JsonRecord): string | undefined {
	const card = vcardValues(entity);
	return text(card.fn) ?? text(card.org) ?? text(entity.name) ?? text(entity.handle);
}

/**
 * Only an entity that explicitly identifies itself with the RDAP `abuse` role
 * can yield a mailbox. Recursive traversal is necessary because registrars and
 * RIRs commonly nest that entity below an organizational entity. We never
 * promote a technical/admin/billing/registrant contact merely because it is
 * nearby in the RDAP response.
 */
export function explicitAbuseMailboxes(entity: unknown, source: AbuseMailbox["source"]): AbuseMailbox[] {
	const record = asRecord(entity);
	if (!record) return [];
	const result: AbuseMailbox[] = [];
	const roles = entityRoles(record);
	if (roles.includes("abuse")) {
		const card = vcardValues(record);
		const emails = uniqueStrings([...scalarStrings(card.email), ...scalarStrings(record.email)].map((value) => normalizeMailbox(value)));
		for (const email of emails) {
			result.push({
				email,
				source,
				entityHandle: text(record.handle),
				entityName: entityDisplayName(record),
				roles,
			});
		}
	}
	for (const child of asArray(record.entities)) result.push(...explicitAbuseMailboxes(child, source));
	return result;
}

export function firstEntityWithRole(root: unknown, role: string): JsonRecord | undefined {
	const record = asRecord(root);
	if (!record) return undefined;
	if (entityRoles(record).includes(role)) return record;
	for (const child of asArray(record.entities)) {
		const found = firstEntityWithRole(child, role);
		if (found) return found;
	}
	return undefined;
}

export function entityOrganization(entity: unknown): JsonRecord | undefined {
	const record = asRecord(entity);
	if (!record) return undefined;
	const card = vcardValues(record);
	const name = entityDisplayName(record);
	const organization = text(card.org) ?? name;
	return organization || text(record.handle)
		? {
			handle: text(record.handle),
			name,
			organization,
			roles: entityRoles(record),
		}
		: undefined;
}

/** Extract an IANA registrar ID only from a registrar entity's explicit identifiers. */
export function extractRegistrarIdFromRdap(registrar: unknown): number | undefined {
	const record = asRecord(registrar);
	if (!record) return undefined;
	for (const publicId of asArray(record.publicIds)) {
		const value = asRecord(publicId);
		const type = text(value?.type)?.toLowerCase();
		const identifier = text(value?.identifier);
		if (!type || !identifier || !/^iana\s+registrar\s+id$/i.test(type) || !/^\d{1,8}$/.test(identifier)) continue;
		const id = Number(identifier);
		if (Number.isSafeInteger(id)) return id;
	}

	// A few authoritative RDAP responses use a normalized `IANA-1234` handle.
	// Do not parse display names or arbitrary strings: provider selection must stay exact.
	const handle = text(record.handle);
	const matched = handle?.match(/^IANA[-_ ]?(\d{1,8})$/i);
	if (!matched) return undefined;
	const id = Number(matched[1]);
	return Number.isSafeInteger(id) ? id : undefined;
}

export function extractPort43(record: JsonRecord | undefined): string | undefined {
	const server = text(record?.port43)?.replace(/\.$/, "");
	if (!server || server.includes(":")) return undefined;
	if (isIP(server)) return isPublicIp(server) ? server : undefined;
	return normalizeDomain(server);
}

export function dedupeMailboxes(mailboxes: AbuseMailbox[]): AbuseMailbox[] {
	const byEmail = new Map<string, AbuseMailbox>();
	for (const mailbox of mailboxes) if (!byEmail.has(mailbox.email)) byEmail.set(mailbox.email, mailbox);
	return [...byEmail.values()];
}

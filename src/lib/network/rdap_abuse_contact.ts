import type { RDAPAbuseContact, RDAPEntity } from "../website/info/info";

/**
 * The first abuse contact in an RDAP entity tree (the registrar, a network),
 * with the remarks of every entity on the way down to it. Pure, so the WHOIS
 * tab in the browser and the server-side lookup share it.
 */
export function recursiveAbuseContact(entity: RDAPEntity, info = ""): RDAPAbuseContact | null {
	if (!entity) return null;

	const remarks = [info, entity.remarks].filter(Boolean).join("\n");
	if (entity.roles?.includes("abuse")) {
		return { ...(entity.vcard ?? {}), remarks };
	}

	if (entity.entities) {
		for (const child of entity.entities) {
			const result = recursiveAbuseContact(child, remarks);
			if (result) return result;
		}
	}

	return null;
}

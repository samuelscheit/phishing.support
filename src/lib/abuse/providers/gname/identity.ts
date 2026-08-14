import { normalizeMailbox } from "../../mail/shared";
import type { AbuseProviderRoute } from "../../schema";

import { gnameServiceIdentity } from "./config";

export type GnameRouteIdentity = {
	name: string;
	mailbox: string;
};

function normalizedServiceName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const name = value.trim();
	return name && name.length <= 256 && !/[\r\n\0]/.test(name) ? name : undefined;
}

/** Read the verified service identity captured durably when this route was verified. */
export function gnameRouteIdentity(route: Pick<AbuseProviderRoute, "serviceIdentity">): GnameRouteIdentity | undefined {
	const identity = route.serviceIdentity;
	if (!identity || identity.verified !== true) return undefined;
	const name = normalizedServiceName(identity.name);
	const mailbox = normalizeMailbox(identity.mailbox);
	return name && mailbox ? { name, mailbox } : undefined;
}

/**
 * Return the route's durable mailbox only while the currently configured,
 * verified GNAME identity still agrees with it. A configuration change must
 * never redirect an already-created external task to another shared inbox.
 */
export function activeGnameRouteIdentity(route: Pick<AbuseProviderRoute, "serviceIdentity">): GnameRouteIdentity | undefined {
	const durable = gnameRouteIdentity(route);
	const configured = gnameServiceIdentity();
	return durable && configured.verified && configured.mailbox === durable.mailbox ? durable : undefined;
}

/** Current verified mailbox for pre-route inbound matching. */
export function configuredGnameMailbox(): string | undefined {
	const identity = gnameServiceIdentity();
	return identity.verified ? identity.mailbox : undefined;
}

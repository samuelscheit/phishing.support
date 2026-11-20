import ipaddr from "ipaddr.js";

import { isPublicIp } from "../abuse/security/security";

/**
 * Whether an address is private, special-use or malformed, so that
 * infrastructure attribution never selects loopback, link-local, reserved,
 * documentation, multicast, or otherwise unroutable addresses as an origin.
 * An IPv4-mapped IPv6 address (`::ffff:8.8.8.8`, how dual-stack hosts write a
 * peer) is judged by the IPv4 address it carries; `isPublicIp` is the one rule.
 */
export function isPrivateIpAddress(value: string): boolean {
	const mapped = ipaddr.IPv6.isValid(value) ? ipaddr.IPv6.parse(value) : undefined;
	return !isPublicIp(mapped?.isIPv4MappedAddress() ? mapped.toIPv4Address().toString() : value);
}

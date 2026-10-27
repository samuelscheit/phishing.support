import ipaddr from "ipaddr.js";

/**
 * Treat every non-unicast address as private or special-use. This keeps
 * infrastructure attribution from selecting loopback, link-local, reserved,
 * documentation, multicast, or otherwise unroutable addresses as an origin.
 */
export function isPrivateIpAddress(value: string): boolean {
	if (!ipaddr.isValid(value)) return true;
	return ipaddr.process(value).range() !== "unicast";
}

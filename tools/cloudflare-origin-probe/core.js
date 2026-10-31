const TUNNEL_PREFIX = "/v1/tcp/";
const TUNNEL_PORT = 443;

export function isIpv4(value) {
	const octets = value.split(".");
	return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

export function suppliedToken(request) {
	return request.headers.get("x-origin-probe-token") ?? "";
}

export function constantTimeEqual(left, right) {
	const length = Math.max(left.length, right.length);
	let difference = left.length ^ right.length;
	for (let index = 0; index < length; index += 1) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}

export function isAuthorized(request, env) {
	const expected = String(env.PROBE_TOKEN ?? "").trim();
	return expected.length >= 32 && constantTimeEqual(suppliedToken(request), expected);
}

export function parseTunnelTarget(pathname) {
	if (!pathname.startsWith(TUNNEL_PREFIX)) throw new TypeError("unknown endpoint");
	const ip = pathname.slice(TUNNEL_PREFIX.length);
	if (!isIpv4(ip)) throw new TypeError("target must be an IPv4 address");
	return { hostname: ip, port: TUNNEL_PORT };
}

export { TUNNEL_PORT };

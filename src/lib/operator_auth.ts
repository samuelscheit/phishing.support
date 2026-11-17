import { timingSafeEqual } from "node:crypto";

/**
 * The operator area (campaigns, criminal referrals) is behind HTTP Basic
 * authentication with `OPERATOR_PASSWORD`; any user name is accepted. Without
 * a configured password of at least 16 characters nobody gets in.
 */
export const OPERATOR_REALM = "phishing.support operator";

export function isOperatorAuthorization(header: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
	const password = env.OPERATOR_PASSWORD;
	if (!password || password.length < 16 || !header?.startsWith("Basic ")) return false;
	let decoded: string;
	try {
		decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf8");
	} catch {
		return false;
	}
	const separator = decoded.indexOf(":");
	if (separator < 0) return false;
	const given = Buffer.from(decoded.slice(separator + 1));
	const expected = Buffer.from(password);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The answer to a request without operator credentials: it asks the browser to log in. */
export function operatorChallenge(): Response {
	return new Response("Operator login required.", {
		status: 401,
		headers: { "WWW-Authenticate": `Basic realm="${OPERATOR_REALM}", charset="UTF-8"`, "Cache-Control": "no-store" },
	});
}

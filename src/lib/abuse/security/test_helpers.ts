import { afterAll, beforeAll } from "bun:test";

/**
 * Sets the secret tracking tokens of idempotent reports (funnel, data-drop,
 * redirector reports) are derived from, for the tests of this file, and
 * restores what was set before.
 */
export function useTrackingTokenSecret(secret = "01234567890123456789012345678901"): void {
	const before = process.env.ABUSE_TRACKING_TOKEN_SECRET;
	beforeAll(() => {
		process.env.ABUSE_TRACKING_TOKEN_SECRET = secret;
	});
	afterAll(() => {
		if (before === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
		else process.env.ABUSE_TRACKING_TOKEN_SECRET = before;
	});
}

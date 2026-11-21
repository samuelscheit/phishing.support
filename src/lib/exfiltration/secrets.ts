/**
 * The credentials of a data drop: a Telegram bot token's secret half and a
 * Discord webhook's token. They let anyone post to, read from or delete the
 * operator's channel, so the public pages show where data went without them;
 * the stored case and the reports to Telegram and Discord keep them whole.
 */
const REDACTED = "[redacted]";

/** `<bot id>:<secret>`, also inside `/bot<id>:<secret>/` and URL-encoded (`%3A`). The bot id stays: it names the bot. */
const TELEGRAM_BOT_TOKEN = /(?<!\d)(\d{5,12})(:|%3A)[A-Za-z0-9_-]{30,}/gi;
/** `/webhooks/<id>/<token>`, also URL-encoded. The webhook id stays. */
const DISCORD_WEBHOOK_TOKEN = /(webhooks(?:\/|%2F)\d{5,20}(?:\/|%2F))[A-Za-z0-9_-]{30,}/gi;

/** The text with every data-drop credential replaced by `[redacted]`. */
export function redactBackendSecrets(text: string): string {
	return text.replace(TELEGRAM_BOT_TOKEN, `$1$2${REDACTED}`).replace(DISCORD_WEBHOOK_TOKEN, `$1${REDACTED}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * A copy of public data with every data-drop credential redacted: in every
 * string of its plain objects and arrays, and a bare `token` field (a Discord
 * webhook's token has no shape of its own) wholly. Dates, bigints and other
 * class instances pass through as they are.
 */
export function withoutBackendSecrets<T>(value: T): T {
	return redact(value, undefined) as T;
}

function redact(value: unknown, key: string | undefined): unknown {
	if (typeof value === "string") {
		const redacted = redactBackendSecrets(value);
		return key === "token" && redacted === value && value ? REDACTED : redacted;
	}
	if (Array.isArray(value)) return value.map((item) => redact(item, undefined));
	if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
	return value;
}

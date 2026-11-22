export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function normalizeMailbox(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const candidate = value.trim().replace(/^<|>$/g, "").toLowerCase();
	if (candidate.length > 320) return undefined;
	if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(candidate)) {
		return undefined;
	}
	return isReservedDomain(candidate.slice(candidate.lastIndexOf("@") + 1)) ? undefined : candidate;
}

/**
 * Names that can never be a real mailbox's domain (RFC 2606, RFC 6761, and
 * mDNS `.local`): registries publish them as placeholders, and mail to them
 * only bounces.
 */
function isReservedDomain(domain: string): boolean {
	const labels = domain.split(".");
	if (["test", "example", "invalid", "localhost", "local"].includes(labels.at(-1)!)) return true;
	return ["example.com", "example.net", "example.org"].includes(labels.slice(-2).join("."));
}

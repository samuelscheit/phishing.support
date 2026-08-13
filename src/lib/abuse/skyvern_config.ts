import fs from "node:fs";
import path from "node:path";

const MINIMUM_API_KEY_LENGTH = 20;

function directValue(): string | undefined {
	const value = process.env.SKYVERN_API_KEY?.trim();
	return value || undefined;
}

function configuredKeyFile(): string | undefined {
	const file = process.env.SKYVERN_API_KEY_FILE?.trim();
	if (!file) return undefined;
	if (!path.isAbsolute(file)) throw new Error("SKYVERN_API_KEY_FILE must be an absolute path.");
	return file;
}

/**
 * The self-hosted Compose deployment creates an organization API token during
 * Skyvern startup and writes it into a private, app-readable Docker volume.
 * Prefer an ordinary injected secret for deployments that already have one,
 * but never put that bootstrap token in a public route or browser payload.
 */
export function skyvernApiKeySourceIsConfigured(): boolean {
	return Boolean(directValue() || configuredKeyFile());
}

export function configuredSkyvernApiKey(): string {
	const direct = directValue();
	if (direct) return direct;
	const file = configuredKeyFile();
	if (!file) throw new Error("SKYVERN_API_KEY or SKYVERN_API_KEY_FILE is not configured.");

	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		throw new Error("Skyvern API-key bootstrap is not ready yet.");
	}
	if (!stat.isFile()) throw new Error("SKYVERN_API_KEY_FILE must reference a regular file.");
	let value: string;
	try {
		value = fs.readFileSync(file, "utf8").trim();
	} catch {
		throw new Error("Skyvern API-key bootstrap could not be read.");
	}
	if (value.length < MINIMUM_API_KEY_LENGTH) throw new Error("Skyvern API-key bootstrap is invalid.");
	return value;
}

export function configuredSkyvernBaseUrl(): string {
	const value = process.env.SKYVERN_BASE_URL?.trim();
	if (!value) throw new Error("SKYVERN_BASE_URL is not configured.");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("SKYVERN_BASE_URL is invalid.");
	}
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
		throw new Error("SKYVERN_BASE_URL must be an HTTP(S) origin without credentials.");
	}
	return url.toString().replace(/\/$/, "");
}

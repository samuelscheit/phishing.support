/**
 * Official VirusTotal v3 API base. Every call sends the key in the `x-apikey`
 * header. The public key allows 4 requests a minute and 500 a day, so callers
 * ask once and treat HTTP 429 as "not now", never as an answer.
 */
export const VIRUSTOTAL_API = "https://www.virustotal.com/api/v3";

/** The key from `VIRUSTOTAL_API_KEY`, or undefined when it is unset or blank. */
export function virusTotalApiKey(environment: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
	return environment.VIRUSTOTAL_API_KEY?.trim() || undefined;
}

import { fetchJson, withTimeout, type FetchImplementation } from "./bounded_fetch";
import { isIP } from "node:net";

const GLOBALPING_MEASUREMENTS_URL = "https://api.globalping.io/v1/measurements";
const DEFAULT_COUNTRIES = ["BR", "DE", "JP", "US"] as const;
const MAX_POLL_ATTEMPTS = 10;

type GlobalpingMeasurement = {
	id?: unknown;
	status?: unknown;
	results?: unknown;
};

type GlobalpingResult = {
	probe?: {
		country?: unknown;
		continent?: unknown;
		region?: unknown;
		city?: unknown;
		network?: unknown;
	};
	result?: {
		status?: unknown;
		statusCode?: unknown;
		statusCodeName?: unknown;
		answers?: unknown;
		timings?: { total?: unknown };
	};
};

export type RegionalDnsAnswer = {
	name?: string;
	value: string;
	type?: string;
	ttl?: number;
};

export type RegionalDnsResult = {
	country: string;
	continent?: string;
	region?: string;
	city?: string;
	network?: string;
	status: string;
	statusCode?: number;
	answers: RegionalDnsAnswer[];
	durationMs?: number;
};

export type RegionalDnsResolution = {
	provider: "globalping";
	recordType: "A" | "AAAA";
	countries: string[];
	results: RegionalDnsResult[];
	resolvedAddresses: string[];
	geographicallyScoped: boolean;
	error?: string;
};

export type RegionalDnsDependencies = {
	fetch?: FetchImplementation;
	timeoutMs?: number;
	retryDelayMs?: number;
	countries?: readonly string[];
	pollAttempts?: number;
	/** Hard cap for the entire create-and-poll measurement workflow. */
	totalTimeoutMs?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: Iterable<string>): string[] {
	return [...new Set([...values].map((value) => value.trim()).filter(Boolean))];
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeCountries(countries: readonly string[] | undefined): string[] {
	const values = countries ?? DEFAULT_COUNTRIES;
	const normalized = values
		.map((country) => country.trim().toUpperCase())
		.filter((country) => /^[A-Z]{2}$/.test(country));
	return uniqueStrings(normalized).slice(0, 8);
}

function parseResult(value: unknown): RegionalDnsResult | undefined {
	const entry = value as GlobalpingResult;
	const probe = asRecord(entry?.probe);
	const result = asRecord(entry?.result);
	const country = string(probe?.country);
	if (!country || !result) return undefined;

	const answers = Array.isArray(result.answers)
		? result.answers.flatMap((answer): RegionalDnsAnswer[] => {
			const record = asRecord(answer);
			const value = string(record?.value);
			if (!value) return [];
			return [{ name: string(record?.name), value, type: string(record?.type), ttl: number(record?.ttl) }];
		})
		: [];
	const timings = asRecord(result.timings);

	return {
		country,
		continent: string(probe?.continent),
		region: string(probe?.region),
		city: string(probe?.city),
		network: string(probe?.network),
		status: string(result.statusCodeName) ?? string(result.status) ?? "unknown",
		statusCode: number(result.statusCode),
		answers,
		durationMs: number(timings?.total),
	};
}

function isFinished(measurement: GlobalpingMeasurement): boolean {
	return measurement.status === "finished" || measurement.status === "failed";
}

function aggregate(recordType: "A" | "AAAA", countries: string[], results: RegionalDnsResult[]): RegionalDnsResolution {
	// Globalping returns CNAMEs in the answer section for an A query.  Keep
	// those records as evidence, but only feed literal A/AAAA values into the
	// IP RDAP resolver; otherwise a filtering/block-page hostname is mistaken
	// for an IP and creates noisy 400s and wasted retries.
	const resolvedAddresses = uniqueStrings(results.flatMap((result) => result.answers
		.filter((answer) => answer.type === recordType || isIP(answer.value) !== 0)
		.map((answer) => answer.value)));
	const countriesWithAnswers = new Set(results.filter((result) => result.answers.length > 0).map((result) => result.country));
	const geographicallyScoped = countriesWithAnswers.size > 0 && countriesWithAnswers.size < countries.length;
	return { provider: "globalping", recordType, countries, results, resolvedAddresses, geographicallyScoped };
}

/**
 * Observe authoritative resolver outcomes from independent countries.  The
 * local resolver remains the primary operational source; this is evidence of
 * geography-scoped DNS (including the one-country phishing technique) and is
 * deliberately non-fatal when the measurement service is unavailable.
 */
async function collectRegionalDns(
	domain: string,
	recordType: "A" | "AAAA",
	dependencies: RegionalDnsDependencies = {},
): Promise<RegionalDnsResolution> {
	const countries = normalizeCountries(dependencies.countries);
	if (countries.length === 0) {
		return { provider: "globalping", recordType, countries: [], results: [], resolvedAddresses: [], geographicallyScoped: false, error: "No valid regional DNS probe countries configured." };
	}

	const requestOptions = {
		fetch: dependencies.fetch,
		timeoutMs: dependencies.timeoutMs ?? 5_000,
		attempts: 2,
		retryDelayMs: dependencies.retryDelayMs ?? 200,
	};

	try {
		const created = await fetchJson<GlobalpingMeasurement>(GLOBALPING_MEASUREMENTS_URL, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({
				type: "dns",
				target: domain,
				locations: countries.map((country) => ({ country, limit: 1 })),
				measurementOptions: { query: { type: recordType } },
			}),
		}, requestOptions);
		const id = string(created?.id);
		if (!id) throw new Error("Regional DNS service did not return a measurement identifier.");

		const pollAttempts = Math.max(1, Math.min(dependencies.pollAttempts ?? MAX_POLL_ATTEMPTS, MAX_POLL_ATTEMPTS));
		let measurement: GlobalpingMeasurement | undefined;
		for (let poll = 0; poll < pollAttempts; poll++) {
			measurement = await fetchJson<GlobalpingMeasurement>(`${GLOBALPING_MEASUREMENTS_URL}/${encodeURIComponent(id)}`, {
				method: "GET",
				headers: { accept: "application/json" },
			}, requestOptions);
			if (measurement && isFinished(measurement)) break;
			// Measurements are asynchronous.  Avoid a tight loop that burns the
			// service quota and repeatedly observes the initial `in-progress`
			// response before probes have had a chance to run.
			if (poll + 1 < pollAttempts) await sleep(Math.max(0, dependencies.retryDelayMs ?? 200));
		}

		if (!measurement || !isFinished(measurement)) {
			throw new Error("Regional DNS measurement timed out before it finished.");
		}
		const results = Array.isArray(measurement.results) ? measurement.results.flatMap((value) => {
			const parsed = parseResult(value);
			return parsed ? [parsed] : [];
		}) : [];
		return aggregate(recordType, countries, results);
	} catch (error) {
		return {
			provider: "globalping",
			recordType,
			countries,
			results: [],
			resolvedAddresses: [],
			geographicallyScoped: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function resolveRegionalDns(
	domain: string,
	recordType: "A" | "AAAA",
	dependencies: RegionalDnsDependencies = {},
): Promise<RegionalDnsResolution> {
	const countries = normalizeCountries(dependencies.countries);
	const perRequestTimeout = dependencies.timeoutMs ?? 5_000;
	const totalTimeoutMs = dependencies.totalTimeoutMs ?? Math.min(perRequestTimeout * 2, 12_000);
	try {
		return await withTimeout(
			() => collectRegionalDns(domain, recordType, dependencies),
			totalTimeoutMs,
			`Regional DNS ${recordType} measurement`,
		);
	} catch (error) {
		return {
			provider: "globalping",
			recordType,
			countries,
			results: [],
			resolvedAddresses: [],
			geographicallyScoped: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

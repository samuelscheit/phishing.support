import { asRecord } from "../../../util/values";
import { deadline, jsonRecord } from "../kit/http";
import { snippet } from "../kit/text";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { GODADDY_PROVIDER as PROVIDER } from "./definition";
import type { GoDaddyReportType } from "./payload";

export type GoDaddyFetch = (url: string, init: RequestInit) => Promise<Pick<Response, "status" | "text">>;

export type GoDaddyApiCredentials = { key: string; secret: string };

export type GoDaddyApiDependencies = {
	fetch?: GoDaddyFetch;
	environment?: Readonly<Record<string, string | undefined>>;
	signal?: AbortSignal;
};

/** The Classic Developer Key from the environment, when both halves are set. */
export function goDaddyApiCredentials(environment: Readonly<Record<string, string | undefined>> = process.env): GoDaddyApiCredentials | undefined {
	const key = environment[PROVIDER.api.keyVariable]?.trim();
	const secret = environment[PROVIDER.api.secretVariable]?.trim();
	return key && secret ? { key, secret } : undefined;
}

const defaultFetch: GoDaddyFetch = (url, init) => fetch(url, init);

async function call(credentials: GoDaddyApiCredentials, path: string, init: { method: "GET" | "POST"; body?: unknown }, dependencies: GoDaddyApiDependencies): Promise<{ status: number; text: string; json: unknown }> {
	const answer = await (dependencies.fetch ?? defaultFetch)(`${PROVIDER.api.baseUrl}${path}`, {
		method: init.method,
		headers: {
			authorization: `sso-key ${credentials.key}:${credentials.secret}`,
			accept: "application/json",
			...(init.body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		signal: deadline(PROVIDER.api.timeoutMs, dependencies.signal),
	});
	const text = await answer.text();
	return { status: answer.status, text, json: jsonRecord(text) };
}

function apiMessage(json: unknown, text: string): string {
	const record = asRecord(json);
	return typeof record?.message === "string" ? snippet(record.message) : snippet(text);
}

/**
 * Whether GoDaddy has enabled the reporter behind these credentials. A read
 * (`GET /v2/abuse/tickets?limit=1`) files nothing, so the channel is decided
 * before the durable marker: 200 means the API, 401/403 ("Unable to complete
 * your request", the answer until onboarding) mean the portal. Anything else
 * (429, 5xx, a dropped connection) is an error to retry.
 */
export async function goDaddyApiEnabled(credentials: GoDaddyApiCredentials, dependencies: GoDaddyApiDependencies = {}): Promise<boolean> {
	const answer = await call(credentials, `${PROVIDER.api.ticketsPath}?limit=1`, { method: "GET" }, dependencies);
	if (answer.status === 200) return true;
	if (answer.status === 401 || answer.status === 403) return false;
	throw new Error(`GoDaddy's Abuse API probe answered HTTP ${answer.status}: ${snippet(answer.text)}`);
}

export type GoDaddyTicketRequest = { type: GoDaddyReportType; source: string; target: string; info: string; infoUrl?: string };

/** What one `POST /v2/abuse/tickets` proved. */
export type GoDaddyTicketOutcome =
	| { kind: "filed"; ticketId: string }
	/** 400/422: GoDaddy refused this URL (an open ticket for the same source exists, an invalid TLD, an unparseable URL). Nothing was filed. */
	| { kind: "refused"; message: string }
	/** 401/403: the key is not (or no longer) enabled. Nothing was filed. */
	| { kind: "not_enabled"; message: string };

/** File one ticket. Rate limits, server errors and malformed answers are ambiguous: they throw a plain Error. */
export async function fileGoDaddyTicket(credentials: GoDaddyApiCredentials, ticket: GoDaddyTicketRequest, dependencies: GoDaddyApiDependencies = {}): Promise<GoDaddyTicketOutcome> {
	const answer = await call(credentials, PROVIDER.api.ticketsPath, {
		method: "POST",
		body: {
			type: ticket.type,
			source: ticket.source,
			target: ticket.target.slice(0, PROVIDER.api.targetMaximumLength),
			info: ticket.info.slice(0, PROVIDER.api.infoMaximumLength),
			...(ticket.infoUrl ? { infoUrl: ticket.infoUrl } : {}),
		},
	}, dependencies);
	const record = asRecord(answer.json);
	if (answer.status === 201) {
		const id = record?.u_number;
		if (typeof id !== "string" || !new RegExp(`^${PROVIDER.api.ticketPattern}$`).test(id)) {
			throw new Error(`GoDaddy's Abuse API created a ticket without a recognizable u_number: ${snippet(answer.text)}`);
		}
		return { kind: "filed", ticketId: id };
	}
	if (answer.status === 400 || answer.status === 422) return { kind: "refused", message: `HTTP ${answer.status}: ${apiMessage(answer.json, answer.text)}` };
	if (answer.status === 401 || answer.status === 403) return { kind: "not_enabled", message: `HTTP ${answer.status}: ${apiMessage(answer.json, answer.text)}` };
	throw new Error(`GoDaddy's Abuse API answered the ticket with HTTP ${answer.status}: ${snippet(answer.text)}`);
}

export type GoDaddyTicketsFiled = { ticketIds: string[]; skipped: string[]; unfiled: string[] };

/**
 * File one ticket per URL, in order, and settle on what the first one proved.
 * The first URL decides alone: its refusal files nothing (rejected, or a
 * person when the key stopped working) and its ambiguity stays ambiguous.
 * Once a ticket exists the report is filed, so a later URL's refusal is only
 * recorded and a later ambiguous or unauthorized answer stops the loop with
 * the rest left unfiled.
 */
export async function fileGoDaddyTickets(credentials: GoDaddyApiCredentials, urls: readonly string[], ticket: Omit<GoDaddyTicketRequest, "source">, dependencies: GoDaddyApiDependencies = {}): Promise<GoDaddyTicketsFiled> {
	const filed: GoDaddyTicketsFiled = { ticketIds: [], skipped: [], unfiled: [] };
	for (const [index, url] of urls.entries()) {
		let outcome: GoDaddyTicketOutcome;
		try {
			outcome = await fileGoDaddyTicket(credentials, { ...ticket, source: url }, dependencies);
		} catch (error) {
			if (filed.ticketIds.length === 0) throw error;
			filed.unfiled.push(...urls.slice(index));
			break;
		}
		if (outcome.kind === "filed") {
			filed.ticketIds.push(outcome.ticketId);
			continue;
		}
		if (filed.ticketIds.length === 0) {
			if (outcome.kind === "refused") throw new ProviderSubmissionRejectedError(`GoDaddy's Abuse API refused ${url} (${outcome.message})`);
			throw new ProviderSubmissionNeedsHumanError(`GoDaddy's Abuse API no longer accepts the reporter key (${outcome.message})`);
		}
		(outcome.kind === "refused" ? filed.skipped : filed.unfiled).push(url);
		if (outcome.kind === "not_enabled") {
			filed.unfiled.push(...urls.slice(index + 1));
			break;
		}
	}
	return filed;
}

export type GoDaddyTicketRecord = { closed: boolean; closeReason?: string };

/** `GET /v2/abuse/tickets/{id}`; undefined when the ticket is not this reporter's (404, or the key not enabled). */
export async function fetchGoDaddyTicket(credentials: GoDaddyApiCredentials, ticketId: string, dependencies: GoDaddyApiDependencies = {}): Promise<GoDaddyTicketRecord | undefined> {
	const answer = await call(credentials, `${PROVIDER.api.ticketsPath}/${encodeURIComponent(ticketId)}`, { method: "GET" }, dependencies);
	if ([401, 403, 404].includes(answer.status)) return undefined;
	const record = asRecord(answer.json);
	if (answer.status !== 200 || typeof record?.closed !== "boolean") throw new Error(`GoDaddy's Abuse API answered ticket ${ticketId} with HTTP ${answer.status}: ${snippet(answer.text)}`);
	return { closed: record.closed, ...(typeof record.closeReason === "string" && record.closeReason ? { closeReason: record.closeReason } : {}) };
}

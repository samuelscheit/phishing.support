import { parse } from "node-html-parser";
import { z } from "zod";

import { userAgent as DESKTOP_USER_AGENT } from "../../constants";
import { SubmissionsEntity } from "../../db/entities";
import { errorSummary } from "../../error_text";
import { readResponseBody } from "../../network/bounded_fetch";
import { fetchThroughPublicRedirects, PublicRedirectError, type PublicRedirectDependencies } from "../../network/public_redirects";
import { createWebsiteSubmission } from "../../submissions/website";
import { analyzeWebsite } from "../../website_ai";
import { websiteSite } from "../../website_site";
import type { WebsiteNavigationHop } from "../../website_types";
import { AbuseRepository } from "../repository";
import type { AbuseJob } from "../schema";
import { normalizePublicHttpUrl } from "../security";
import { throwIfAborted } from "../worker/shared";
import { redirectParentId } from "./kit_job";

/**
 * A redirector is the link a campaign hands out (in its emails, its ads)
 * that sends each visitor on to the kit's current host. The operator swaps
 * that host when it is taken down; the link stays. openanonymity.chat/x/ sent
 * visitors to x-com.email, then to assistdeparments-x.com. A watch visits the
 * redirector once a day and reports each new host it leads to.
 */
export const REDIRECTOR_WATCH_INTERVAL_MS = 24 * 60 * 60_000;
/** Consecutive daily checks on which neither route reached the redirector before the watch ends. */
export const REDIRECTOR_WATCH_MAX_MISSES = 3;
/** A redirector that leads nowhere new for this long has been abandoned. */
export const REDIRECTOR_WATCH_QUIET_MS = 30 * 24 * 60 * 60_000;
/**
 * Every this many checks the browser visits even when the cheap check saw a
 * known host: a cloaker may show a plain HTTP client a decoy it never
 * changes and send browsers to the new kit.
 */
export const REDIRECTOR_WATCH_BROWSER_EVERY = 7;

const HTTP_REDIRECTS_PER_PAGE = 5;
/** Pages that send the visitor on by markup or script, followed one after another. */
const MAX_PAGE_REDIRECTS = 5;
const CHECK_TIMEOUT_MS = 15_000;
/** A page that only sends its visitor on is a few hundred bytes; a kit page that big holds no redirect worth reading. */
const MAX_PAGE_BYTES = 512 * 1024;

/** Kept of a page the redirector served, as evidence of how it sends visitors on. */
const MAX_EVIDENCE_PAGE_CHARACTERS = 64 * 1024;

/** The last page the redirector served on its own site: the one that sent the visitor on, or that stayed. */
export type RedirectorPage = { url: string; status: number; html: string };

/** Where the cheap check of a redirector ended. */
export type RedirectorCheck = (
	/** The redirector sent the visitor to another site; `url` is the last page reached there. */
	| { kind: "destination"; url: string; urls: string[] }
	/** The redirector answered with a page of its own that sends the visitor nowhere a plain client can follow. */
	| { kind: "stays"; urls: string[] }
	/** The redirector did not answer, or answered with an error, and sent the visitor nowhere. */
	| { kind: "unreachable"; reason: string; urls: string[] }
) & { page?: RedirectorPage };

/**
 * The page a document sends its visitor to by itself: a `<meta http-equiv="refresh">`
 * or a script that assigns a string literal to `location`. Anything computed
 * at run time is left to the browser check.
 */
export function documentRedirect(html: string, pageUrl: string): string | undefined {
	const root = parse(html, { comment: false });
	const absolute = (target: string | undefined) => {
		if (!target) return undefined;
		try {
			const url = new URL(target.trim(), pageUrl);
			return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
		} catch {
			return undefined;
		}
	};
	for (const meta of root.querySelectorAll("meta[http-equiv]")) {
		if (meta.getAttribute("http-equiv")?.trim().toLowerCase() !== "refresh") continue;
		const target = /^\s*\d*(?:\.\d+)?\s*[;,]\s*url\s*=\s*(['"]?)(.+?)\1\s*$/i.exec(meta.getAttribute("content") ?? "")?.[2];
		const url = absolute(target);
		if (url) return url;
	}
	const assignment = /\b(?:(?:window|document|top|self|parent)\s*\.\s*)?location(?:\s*\.\s*href)?\s*=\s*(['"`])([^'"`\s]+)\1|\blocation\s*\.\s*(?:replace|assign)\s*\(\s*(['"`])([^'"`\s]+)\3\s*\)/;
	for (const script of root.querySelectorAll("script")) {
		if (script.getAttribute("src")) continue;
		const found = assignment.exec(script.textContent);
		const url = absolute(found?.[2] ?? found?.[4]);
		if (url) return url;
	}
	return undefined;
}

export type RedirectorCheckDependencies = PublicRedirectDependencies;

/**
 * Visit the redirector as a plain HTTP client would and follow it as far as
 * it goes without running scripts: HTTP redirects, then meta refreshes and
 * literal `location` assignments. Every hop must be a public host.
 */
export async function checkRedirector(url: string, dependencies: RedirectorCheckDependencies = {}): Promise<RedirectorCheck> {
	const site = websiteSite(url);
	const urls: string[] = [];
	let current = url;
	let failure: string | undefined;
	let page: RedirectorPage | undefined;
	for (let step = 0; step <= MAX_PAGE_REDIRECTS; step++) {
		let response: Response;
		try {
			const answer = await fetchThroughPublicRedirects(current, {
				...dependencies,
				subject: "redirector",
				headers: { "user-agent": DESKTOP_USER_AGENT, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" },
				maxRedirects: HTTP_REDIRECTS_PER_PAGE,
				timeoutMs: CHECK_TIMEOUT_MS,
			});
			urls.push(...answer.urls);
			response = answer.response;
		} catch (error) {
			if (error instanceof PublicRedirectError) urls.push(...error.urls);
			failure = errorSummary(error);
			break;
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			failure = `HTTP ${response.status} at ${urls.at(-1)}`;
			break;
		}
		const isHtml = /\bhtml\b/i.test(response.headers.get("content-type") ?? "text/html");
		const body = isHtml ? await readResponseBody(response, MAX_PAGE_BYTES).catch(() => undefined) : undefined;
		if (!isHtml) await response.body?.cancel().catch(() => undefined);
		const html = body?.toString("utf8");
		if (html !== undefined && websiteSite(urls.at(-1)!) === site) page = { url: urls.at(-1)!, status: response.status, html: html.slice(0, MAX_EVIDENCE_PAGE_CHARACTERS) };
		const next = html ? documentRedirect(html, urls.at(-1)!) : undefined;
		if (!next || urls.includes(next)) break;
		current = next;
	}
	const away = urls.filter((reached) => websiteSite(reached) !== site);
	const evidence = page ? { page } : {};
	if (away.length) return { kind: "destination", url: away.at(-1)!, urls, ...evidence };
	return failure ? { kind: "unreachable", reason: failure, urls, ...evidence } : { kind: "stays", urls, ...evidence };
}

const watchStateSchema = z.object({
	url: z.string(),
	/** Every site the redirector has led to, the one that started the watch first. */
	sites: z.array(z.string()).min(1),
	checks: z.number().int().nonnegative(),
	misses: z.number().int().nonnegative(),
	/** When the redirector last led somewhere new, ISO 8601. */
	lastNewAt: z.string().datetime(),
});
export type RedirectorWatchState = z.infer<typeof watchStateSchema>;

const watchDedupeKey = (url: string) => `watch-redirector:${url}`;

/**
 * The redirector a destination case was reached through: the last page of the
 * submitted chain that sent the visitor on by itself (an HTTP redirect, a
 * refresh, a script) and is not on the destination's site. A page the
 * capture had to act on (follow a link, fill a field) is a step of a flow,
 * not something that hands out the kit.
 */
export function redirectorHop(hops: readonly WebsiteNavigationHop[], destinationUrl: string): WebsiteNavigationHop | undefined {
	const destination = websiteSite(destinationUrl);
	const arrival = hops.findIndex((hop) => websiteSite(hop.url) === destination);
	const hop = arrival > 0 ? hops[arrival - 1] : undefined;
	if (!hop?.redirectTo || hop.followedLink || hop.performedAction || hop.revisitedAs) return undefined;
	return hop;
}

/** A confirmed destination's redirector, with the chain it was recorded in. */
export type RedirectorOf = {
	url: string;
	destinationUrl: string;
	/** The submitted case whose capture went through the redirector to the destination. */
	parent: { id: bigint; createdAt: Date; hops: WebsiteNavigationHop[] };
};

/** The redirector a destination case was reached through, from the chain of the case that handed off to it. */
export async function redirectorOf(submissionId: bigint): Promise<RedirectorOf | undefined> {
	const destination = await SubmissionsEntity.get(submissionId);
	const parentId = redirectParentId(destination?.source);
	if (destination?.data.kind !== "website" || parentId === undefined) return undefined;
	const parent = await SubmissionsEntity.get(parentId);
	if (parent?.data.kind !== "website") return undefined;
	const hops = parent.data.website.navigationHops ?? [];
	const hop = redirectorHop(hops, destination.data.website.url);
	const url = hop ? normalizePublicHttpUrl(hop.url) : undefined;
	return url ? { url, destinationUrl: destination.data.website.url, parent: { id: parent.id, createdAt: parent.createdAt, hops } } : undefined;
}

/**
 * Start watching the redirector a confirmed destination was reached through.
 * One watch runs per redirector URL; a report for a host the watch itself
 * found finds that watch still running and adds nothing.
 */
export async function enqueueRedirectorWatch(reportId: bigint, submissionId: bigint, now = new Date()): Promise<void> {
	const redirector = await redirectorOf(submissionId);
	if (!redirector) return;
	const { url } = redirector;
	const state: RedirectorWatchState = { url, sites: [websiteSite(redirector.destinationUrl)], checks: 0, misses: 0, lastNewAt: now.toISOString() };
	await AbuseRepository.enqueueJob({
		jobType: "watch_redirector",
		reportId,
		payload: state,
		dedupeKey: watchDedupeKey(url),
		nextAttemptAt: new Date(now.getTime() + REDIRECTOR_WATCH_INTERVAL_MS),
	});
}

/** What a browser visit of the redirector found, read back from the case it opened. */
export type RedirectorVisit = { submissionId: bigint; status: string; destination?: string };

export type RedirectorWatchDependencies = {
	checkRedirector?: (url: string, dependencies: RedirectorCheckDependencies) => Promise<RedirectorCheck>;
	analyzeWebsite?: typeof analyzeWebsite;
	now?: () => Date;
};

/**
 * Visit the redirector in the browser as a new case, dated by this check: the
 * site's earlier cases stay as they were. The full analysis runs, cloaking
 * routes and verification gates included; a capture that ends on another
 * site hands off to that site's own case, which is reported as usual.
 */
async function visitRedirector(job: AbuseJob, state: RedirectorWatchState, dependencies: RedirectorWatchDependencies): Promise<RedirectorVisit> {
	const report = await AbuseRepository.getReport(job.reportId!);
	let analysis: Promise<unknown> | undefined;
	const submissionId = await createWebsiteSubmission({
		url: state.url,
		source: `redirector-watch:${job.reportId!.toString()}`,
		visit: `watch-${job.id.toString()}`,
		reporterIp: report?.requesterIp ?? undefined,
		reporterCountry: report?.requesterCountry ?? undefined,
		reporterHeaders: report?.requesterHeaders ?? undefined,
	}, (options) => (analysis = (dependencies.analyzeWebsite ?? analyzeWebsite)(options)));
	// Waiting keeps the capture inside the worker lane's concurrency. A retried
	// job finds its case already created and reads what it found.
	await analysis;
	const visited = await SubmissionsEntity.get(submissionId);
	const website = visited?.data.kind === "website" ? visited.data.website : undefined;
	const handedOff = website?.redirectSubmissionId ? await SubmissionsEntity.get(BigInt(website.redirectSubmissionId)) : undefined;
	const destination = handedOff?.data.kind === "website" ? handedOff.data.website.url : undefined;
	return { submissionId, status: visited?.status ?? "missing", ...(destination ? { destination } : {}) };
}

/**
 * One daily check of a watched redirector. The cheap check runs first; the
 * browser visits when it saw a new host, could not follow the redirector, or
 * could not reach it (a cloaker may refuse the server's own address), and on
 * every seventh check regardless. The watch queues its next check, or ends
 * after three days on which nothing reached the redirector, or thirty days
 * without a new host.
 */
export async function watchRedirector(
	params: { job: AbuseJob; signal?: AbortSignal },
	dependencies: RedirectorWatchDependencies = {},
): Promise<void> {
	const { job, signal } = params;
	const parsed = watchStateSchema.safeParse(job.payload);
	if (!parsed.success || !job.reportId) throw new Error("Redirector watch job has an invalid state.");
	const state = parsed.data;
	const now = (dependencies.now ?? (() => new Date()))();
	const checks = state.checks + 1;

	const check = await (dependencies.checkRedirector ?? checkRedirector)(state.url, { signal });
	throwIfAborted(signal);
	const checkedSite = check.kind === "destination" ? websiteSite(check.url) : undefined;
	const visit = checkedSite && state.sites.includes(checkedSite) && checks % REDIRECTOR_WATCH_BROWSER_EVERY !== 0
		? undefined
		: await visitRedirector(job, state, dependencies);
	throwIfAborted(signal);

	const reached = [checkedSite, visit?.destination ? websiteSite(visit.destination) : undefined].filter((site): site is string => Boolean(site));
	const found = [...new Set(reached.filter((site) => !state.sites.includes(site)))];
	// The browser reaching the redirector at all (its own page, a decoy) is an answer.
	const answered = check.kind !== "unreachable" || (visit !== undefined && visit.status !== "failed");
	const next: RedirectorWatchState = {
		url: state.url,
		sites: [...state.sites, ...found],
		checks,
		misses: answered ? 0 : state.misses + 1,
		lastNewAt: found.length ? now.toISOString() : state.lastNewAt,
	};
	const ended = next.misses >= REDIRECTOR_WATCH_MAX_MISSES
		? `nothing reached the redirector on ${next.misses} daily checks in a row`
		: now.getTime() - Date.parse(next.lastNewAt) >= REDIRECTOR_WATCH_QUIET_MS
			? `the redirector led nowhere new in ${Math.round(REDIRECTOR_WATCH_QUIET_MS / 86_400_000)} days`
			: undefined;

	await AbuseRepository.appendEvent({
		reportId: job.reportId,
		jobId: job.id,
		eventType: "redirector_watch.checked",
		data: {
			url: state.url,
			check: check.kind === "destination" ? { kind: check.kind, url: check.url } : check.kind === "unreachable" ? { kind: check.kind, reason: check.reason } : { kind: check.kind },
			...(visit ? { visit: { submissionId: visit.submissionId.toString(), status: visit.status, ...(visit.destination ? { destination: visit.destination } : {}) } } : {}),
			newSites: found,
			checks,
			...(ended ? { ended } : {}),
		},
	});
	if (ended) return;
	await AbuseRepository.enqueueJob({
		jobType: "watch_redirector",
		reportId: job.reportId,
		payload: next,
		dedupeKey: watchDedupeKey(state.url),
		nextAttemptAt: new Date(now.getTime() + REDIRECTOR_WATCH_INTERVAL_MS),
		successorOf: job.id,
	});
}

import { createHash } from "node:crypto";

import { AbuseRepository } from "../abuse/repository";
import { kitFingerprints, type KitFingerprintKind } from "../abuse/origin/siblings";
import { presentedCertificate, type TlsProbe } from "../abuse/origin/sweep";
import { CampaignRepository } from "../campaign/repository";
import { SubmissionsEntity } from "../db/entities/submissions";
import { readResponseBody } from "../network/bounded_fetch";
import { fetchThroughPublicRedirects } from "../network/public_redirects";
import { browserRequestHeaders } from "../network/service_identity";
import { urlHostname } from "../network/url";
import type { SiteCheckDependencies, SiteCheckResult } from "./check";
import { addressIdentity, attributeHosting, hostingChange, hostingIdentities, hostingKey, hostingNetwork, networkIdentities, routedHosting, type HostingChange, type NetworkLookup, type SiteHosting } from "./hosting";
import { HOST_MOVED_EVENT, hostMovesOf, type HostMove, type MoveContent } from "./moves";
import type { SiteCheck } from "./schema";

const CERTIFICATE_TIMEOUT_MS = 5_000;
const FILE_TIMEOUT_MS = 15_000;
/** Kit files are scripts and frame documents; one larger than this is not one the capture kept. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Captured files compared per check: each is one request to the site. */
const MAX_PROOF_FILES = 5;

/**
 * Files any site may serve: public libraries and frameworks, CMS cores, the
 * scripts of analytics, consent and captcha services. Serving one proves
 * nothing about which site it is.
 */
const LIBRARY_PATH = /(?:^|[/._-])(?:jquery|bootstrap|popper|lodash|underscore|react(?:-dom)?|vue|angular|moment|axios|modernizr|polyfills?|core-js|swiper|slick|owl\.carousel|select2|gsap|three|chart|d3|font-?awesome|fontawesome|aos|wow|lazysizes|recaptcha|hcaptcha|turnstile|gtag|analytics|gtm|fbevents|cookieconsent|wp-emoji|wp-embed)(?:[/._-]|$)|\/(?:wp-includes|wp-content\/plugins|node_modules|vendor|libs?|cdn-cgi)\//i;

/** A captured file of the reported host that only its own kit serves, to be fetched from wherever the site moved. */
export type MoveProofFile = { path: string; sha256: string; kind: KitFingerprintKind };

export type HostMoveDependencies = {
	/** The network of an address; production asks RIPEstat. */
	network?: NetworkLookup;
	/** The certificate an address presents for a name; production completes a TLS handshake. */
	certificate?: TlsProbe;
	/** The captured files that prove the site is the reported one; production reads the case's capture (`moveProofFiles`). */
	proofFiles?: (params: { submissionId: bigint | null; host: string; reportId: bigint }) => Promise<MoveProofFile[]>;
};

/** The reported site's target, as a move is judged and recorded for it. */
export type MoveTarget = { targetId: bigint; reportId: bigint; url: string };

/**
 * The files the case captured that can prove a server serves the reported
 * site: its own scripts and hidden frames on the reported host, never a
 * stylesheet (templates share them), a library by its name or path, or a
 * file many unrelated sites serve (`isSharedKitFile`).
 */
export async function moveProofFiles(params: { submissionId: bigint | null; host: string; reportId: bigint }, isShared: (sha256: string, reportId: bigint) => Promise<boolean> = CampaignRepository.isSharedKitFile): Promise<MoveProofFile[]> {
	if (params.submissionId === null) return [];
	const submission = await SubmissionsEntity.get(params.submissionId);
	if (submission?.data.kind !== "website") return [];
	const files: MoveProofFile[] = [];
	for (const fingerprint of kitFingerprints(submission.data.website)) {
		if (files.length >= MAX_PROOF_FILES) break;
		const url = new URL(fingerprint.url);
		if (fingerprint.kind === "stylesheet" || url.hostname !== params.host || LIBRARY_PATH.test(url.pathname)) continue;
		if (await isShared(fingerprint.sha256, params.reportId)) continue;
		files.push({ path: `${url.pathname}${url.search}`, sha256: fingerprint.sha256, kind: fingerprint.kind });
	}
	return files;
}

/** The check's addresses with their networks; addresses the previous check attributed are not looked up again. */
export async function attributeCheck(result: SiteCheckResult, previous: SiteCheck | undefined, dependencies: HostMoveDependencies): Promise<SiteCheckResult> {
	if (!result.hosting) return result;
	return { ...result, hosting: await attributeHosting(result.hosting, previous?.hosting, dependencies.network) };
}

/** The proof files its current hosting serves byte for byte, requested as the capture's browser did. */
async function servedKitFiles(url: string, files: readonly MoveProofFile[], dependencies: SiteCheckDependencies): Promise<Array<{ url: string; sha256: string }>> {
	const origin = new URL(url).origin;
	const served: Array<{ url: string; sha256: string }> = [];
	for (const file of files) {
		const fileUrl = `${origin}${file.path}`;
		try {
			const { response } = await fetchThroughPublicRedirects(fileUrl, {
				...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
				...(dependencies.assertPublicHost ? { assertPublicHost: dependencies.assertPublicHost } : {}),
				...(dependencies.signal ? { signal: dependencies.signal } : {}),
				subject: "reported site",
				headers: { ...browserRequestHeaders },
				maxRedirects: 0,
				timeoutMs: FILE_TIMEOUT_MS,
			});
			if (response.status !== 200) {
				await response.body?.cancel().catch(() => undefined);
				continue;
			}
			const sha256 = createHash("sha256").update(await readResponseBody(response, MAX_FILE_BYTES)).digest("hex");
			if (sha256 === file.sha256) served.push({ url: fileUrl, sha256 });
		} catch {
			if (dependencies.signal?.aborted) throw dependencies.signal.reason;
		}
	}
	return served;
}

/**
 * The hosting the current check is compared with: the last check whose
 * networks were all known (one failed lookup must not stand in for where the
 * site was), else the addresses the report was routed on.
 */
function baselineOf(checks: readonly SiteCheck[], routed: SiteHosting | undefined, reportedAt: Date): { hosting: SiteHosting; since: Date } | undefined {
	const last = checks.findLast((check) => check.hosting && hostingKey(check.hosting) !== undefined);
	if (last?.hosting) return { hosting: last.hosting, since: last.checkedAt };
	return routed ? { hosting: routed, since: reportedAt } : undefined;
}

/**
 * Every network and address the site was seen at since it was reported: as
 * routed, at every check (those made before checks recorded networks by
 * their addresses), and at either end of every move.
 */
function seenNetworks(routed: SiteHosting | undefined, checks: readonly SiteCheck[], moves: readonly HostMove[]): Set<string> {
	const seen = new Set<string>();
	for (const hosting of [routed, ...checks.map((check) => check.hosting)]) {
		for (const address of hosting?.addresses ?? []) for (const identity of networkIdentities(address)) seen.add(identity);
	}
	// An address counts where its network was known, or where the check predates recording networks;
	// one whose lookup failed proves nothing, or a failed lookup would hide the move it found.
	const known = (hosting: SiteHosting | null | undefined) => (hosting?.addresses ?? []).filter((address) => networkIdentities(address).length).map(({ ip }) => ip);
	for (const address of [...known(routed), ...checks.flatMap((check) => (check.hosting ? known(check.hosting) : check.resolvedAddresses))]) seen.add(addressIdentity(address));
	for (const move of moves) {
		for (const network of [move.from, move.to]) {
			for (const identity of networkIdentities(network)) seen.add(identity);
			for (const address of network.addresses) seen.add(addressIdentity(address));
		}
	}
	return seen;
}

const queueMoveReport = (move: HostMove, reportId: bigint) => AbuseRepository.enqueueJobOnce({
	jobType: "report_host_move",
	reportId,
	payload: { key: move.key },
	dedupeKey: `host-move:${move.key}`,
});

export type ObservedMove = {
	/** The move this check recorded, newly or with its content confirmed now. */
	move?: HostMove;
	/** The check before this one found a move: this check is that move's recheck. */
	recheck: boolean;
};

/**
 * Whether the check finds the site at a network it was never seen at since
 * the report, and if so whether it still serves what was reported there,
 * recorded as a durable `site.host_moved` event. A return to a network seen
 * before is no move, so a site flapping between two hosts moves once.
 *
 * The content counts as served only when the check found the site up and
 * the new hosting returned, byte for byte, at least one file only the
 * reported site's kit serves (`moveProofFiles`); a move whose content was
 * not confirmed is checked again while the site stays there. The record is
 * written before the check itself and the report job is queued once per
 * move, also by a retry that finds the move already confirmed.
 */
export async function observeHostMove(params: {
	target: MoveTarget;
	result: SiteCheckResult;
	checks: readonly SiteCheck[];
	jobId?: bigint;
}, dependencies: SiteCheckDependencies & HostMoveDependencies = {}): Promise<ObservedMove> {
	const { target, result, checks } = params;
	const [row, report, events] = await Promise.all([
		AbuseRepository.getTarget(target.targetId),
		AbuseRepository.getReport(target.reportId),
		AbuseRepository.listEvents(target.reportId),
	]);
	const recorded = hostMovesOf(events).filter((move) => move.targetId === target.targetId.toString());
	const previous = checks.at(-1);
	const recheck = previous !== undefined && recorded.some((move) => move.at === previous.checkedAt.toISOString());
	const current = result.hosting;
	// Only a domain can move: an address is where it is.
	if (!current?.addresses.length || row?.targetType !== "domain" || !report) return { recheck };
	const routed = routedHosting(row.resolverSnapshot);
	const baseline = baselineOf(checks, routed, report.createdAt);
	const currentKey = hostingKey(current);
	if (!baseline || !currentKey) return { recheck };

	const key = `${target.targetId.toString()}->${currentKey}`;
	let change: HostingChange | undefined = hostingChange(baseline.hosting, current, seenNetworks(routed, checks, recorded));
	let since = baseline.since.toISOString();
	const known = recorded.find((move) => move.key === key);
	if (!change) {
		// The site stays where a move took it: a confirmed move is queued (once), an unconfirmed one looked at again.
		if (!known || recorded.at(-1)?.key !== key || !hostingIdentities(current)) return { recheck };
		if (known.content === "served") {
			await queueMoveReport(known, target.reportId);
			return { recheck };
		}
		change = { kind: known.kind, from: known.from, to: hostingNetwork(current) };
		since = known.since;
	} else if (known?.content === "served") {
		await queueMoveReport(known, target.reportId);
		return { recheck };
	}

	const host = urlHostname(new URL(target.url));
	const files = await (dependencies.proofFiles ?? moveProofFiles)({ submissionId: report.submissionId, host, reportId: target.reportId });
	const kitFiles = files.length ? await servedKitFiles(target.url, files, dependencies) : [];
	const content: MoveContent = !kitFiles.length ? (files.length ? "gone" : "unknown") : result.state === "online" ? "served" : "unknown";
	if (known && content === known.content) return { recheck };
	const certificate = target.url.startsWith("https:") && change.to.addresses[0]
		? await (dependencies.certificate ?? presentedCertificate)(change.to.addresses[0], host, CERTIFICATE_TIMEOUT_MS).catch(() => undefined)
		: undefined;
	const move: HostMove = {
		key,
		targetId: target.targetId.toString(),
		at: result.checkedAt.toISOString(),
		since,
		kind: change.kind,
		from: change.from,
		to: change.to,
		content,
		evidence: {
			url: target.url,
			state: result.state,
			httpStatus: result.httpStatus ?? null,
			...(current.server ? { server: current.server } : {}),
			...(certificate ? { certificate } : {}),
			kitFiles,
		},
	};
	await AbuseRepository.appendEvent({ reportId: target.reportId, targetId: target.targetId, ...(params.jobId === undefined ? {} : { jobId: params.jobId }), eventType: HOST_MOVED_EVENT, data: move });
	if (content === "served") await queueMoveReport(move, target.reportId);
	return { move, recheck };
}

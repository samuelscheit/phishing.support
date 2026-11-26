import { createHash } from "node:crypto";

import { AbuseRepository } from "../abuse/repository";
import { presentedCertificate, type OriginVerificationTarget, type TlsProbe } from "../abuse/origin/sweep";
import { originVerificationTargets } from "../abuse/origin/verification_targets";
import { readResponseBody } from "../network/bounded_fetch";
import { fetchThroughPublicRedirects } from "../network/public_redirects";
import { browserRequestHeaders } from "../network/service_identity";
import { urlHostname } from "../network/url";
import type { SiteCheckDependencies, SiteCheckResult } from "./check";
import { attributeAddresses, hostingChange, hostingKey, hostingNetwork, routedHosting, type HostingChange, type NetworkLookup, type SiteHosting } from "./hosting";
import { HOST_MOVED_EVENT, hostMovesOf, type HostMove, type MoveContent } from "./moves";
import type { SiteCheck } from "./schema";

const CERTIFICATE_TIMEOUT_MS = 5_000;
const FILE_TIMEOUT_MS = 15_000;
/** Kit files are scripts and stylesheets; one larger than this is not one the capture kept. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export type HostMoveDependencies = {
	/** The network of an address; production asks RIPEstat. */
	network?: NetworkLookup;
	/** The certificate an address presents for a name; production completes a TLS handshake. */
	certificate?: TlsProbe;
	/** The captured files of the reported host to compare; production reads the case's capture. */
	verificationTargets?: (submissionId: bigint | null, domain: string) => Promise<OriginVerificationTarget[]>;
};

/** The reported site's target, as a move is judged and recorded for it. */
export type MoveTarget = { targetId: bigint; reportId: bigint; url: string };

/** The check's addresses with their networks; addresses the previous check attributed are not looked up again. */
export async function attributeHosting(result: SiteCheckResult, previous: SiteCheck | undefined, dependencies: HostMoveDependencies): Promise<SiteCheckResult> {
	if (!result.hosting) return result;
	const addresses = await attributeAddresses(result.hosting.addresses.map(({ ip }) => ip), previous?.hosting, dependencies.network);
	return { ...result, hosting: { ...result.hosting, addresses } };
}

/**
 * The files the case captured from the reported host that its current
 * hosting serves byte for byte, requested as the capture's browser did.
 */
async function servedKitFiles(url: string, targets: readonly OriginVerificationTarget[], dependencies: SiteCheckDependencies): Promise<Array<{ url: string; sha256: string }>> {
	const origin = new URL(url).origin;
	const served: Array<{ url: string; sha256: string }> = [];
	for (const target of targets) {
		const fileUrl = `${origin}${target.path}`;
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
			if (sha256 === target.sha256) served.push({ url: fileUrl, sha256 });
		} catch {
			if (dependencies.signal?.aborted) throw dependencies.signal.reason;
		}
	}
	return served;
}

/**
 * The hosting the current check is compared with: the last check that
 * recorded its networks, else the addresses the report was routed on.
 */
function baselineOf(checks: readonly SiteCheck[], resolverSnapshot: Record<string, unknown> | null, reportedAt: Date): { hosting: SiteHosting; source: string; since: Date } | undefined {
	const last = checks.findLast((check) => check.hosting?.addresses.length);
	if (last?.hosting) return { hosting: last.hosting, source: `check:${last.id.toString()}`, since: last.checkedAt };
	const routed = routedHosting(resolverSnapshot);
	return routed ? { hosting: routed, source: "routed", since: reportedAt } : undefined;
}

/**
 * Whether the check finds the site at another network than before, and if
 * so whether it still serves what was reported, recorded as a durable
 * `site.host_moved` event. A move whose content could not be confirmed is
 * checked again while the site stays where it moved. The record is written
 * before the check itself, so a retried check finds the same move under the
 * same key and records nothing twice. Returns the move when one was
 * recorded (newly, or its content confirmed now).
 */
export async function observeHostMove(params: {
	target: MoveTarget;
	result: SiteCheckResult;
	checks: readonly SiteCheck[];
	jobId?: bigint;
}, dependencies: SiteCheckDependencies & HostMoveDependencies = {}): Promise<HostMove | undefined> {
	const { target, result, checks } = params;
	const current = result.hosting;
	if (!current?.addresses.length) return undefined;
	const [row, report, events] = await Promise.all([
		AbuseRepository.getTarget(target.targetId),
		AbuseRepository.getReport(target.reportId),
		AbuseRepository.listEvents(target.reportId),
	]);
	// Only a domain can move: an address is where it is.
	if (row?.targetType !== "domain" || !report) return undefined;
	const baseline = baselineOf(checks, row.resolverSnapshot, report.createdAt);
	const currentKey = hostingKey(current);
	if (!baseline || !currentKey) return undefined;

	const recorded = hostMovesOf(events).filter((move) => move.targetId === target.targetId.toString());
	let change: HostingChange | undefined = hostingChange(baseline.hosting, current);
	let key = change && `${target.targetId.toString()}:${baseline.source}:${hostingKey(baseline.hosting)}->${currentKey}`;
	let since = baseline.since.toISOString();
	if (!change) {
		// The site stays where a move took it, and that move's content is not confirmed yet: look again.
		const pending = recorded.at(-1);
		if (pending?.content === "served" || !pending || !pending.key.endsWith(`->${currentKey}`)) return undefined;
		change = { kind: pending.kind, from: pending.from, to: hostingNetwork(current) };
		key = pending.key;
		since = pending.since;
	}
	// A move on record whose content was confirmed is settled; a retried check finds it so.
	const known = recorded.find((move) => move.key === key);
	if (known?.content === "served") return undefined;

	const host = urlHostname(new URL(target.url));
	const targets = await (dependencies.verificationTargets ?? originVerificationTargets)(report.submissionId, host);
	const kitFiles = targets.length ? await servedKitFiles(target.url, targets, dependencies) : [];
	const content: MoveContent = !targets.length ? "unknown" : kitFiles.length ? "served" : "gone";
	if (known && content === known.content) return undefined;
	const certificate = target.url.startsWith("https:") && change.to.addresses[0]
		? await (dependencies.certificate ?? presentedCertificate)(change.to.addresses[0], host, CERTIFICATE_TIMEOUT_MS).catch(() => undefined)
		: undefined;
	const move: HostMove = {
		key: key!,
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
	if (content === "served") {
		await AbuseRepository.enqueueJobOnce({
			jobType: "report_host_move",
			reportId: target.reportId,
			payload: { key: move.key },
			dedupeKey: `host-move:${move.key}`,
		});
	}
	return move;
}

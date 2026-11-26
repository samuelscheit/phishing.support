import { z } from "zod";

import type { Locale } from "../i18n/locale";
import { isUp } from "./layer";
import type { SiteCheckState } from "./schema";

/** The event that records a reported site moving to another network: one per move and outcome of its content check. */
export const HOST_MOVED_EVENT = "site.host_moved";
/** The event that records what was done about a move on one route: a new report, a follow-up, or why nothing could be sent. */
export const HOST_MOVE_ACTION_EVENT = "site.host_move_action";

const networkSchema = z.object({
	name: z.string(),
	cdn: z.string().optional(),
	asn: z.number().int().positive().optional(),
	holder: z.string().optional(),
	addresses: z.array(z.string()),
});

const certificateSchema = z.object({
	names: z.array(z.string()),
	notBefore: z.string(),
	notAfter: z.string(),
	issuer: z.string(),
	fingerprint256: z.string(),
});

/**
 * Whether the new hosting serves what was reported: `served` when files the
 * case captured came back byte for byte, `gone` when none did, `unknown`
 * when the case captured no file of the site to compare.
 */
const moveContents = ["served", "gone", "unknown"] as const;
export type MoveContent = (typeof moveContents)[number];

const hostMoveSchema = z.object({
	/** Names the move: the target, where it was seen before, and where it went. */
	key: z.string(),
	targetId: z.string(),
	/** When the check that found the site at its new hosting ran, ISO 8601. */
	at: z.string(),
	/** When the site was last seen at its old hosting: the check before, or the report it was routed on. The move happened in between. */
	since: z.string(),
	kind: z.enum(["left_cdn", "new_cdn", "new_network"]),
	from: networkSchema,
	to: networkSchema,
	content: z.enum(moveContents),
	evidence: z.object({
		url: z.string(),
		state: z.string(),
		httpStatus: z.number().int().nullable(),
		/** The `Server` header the site answered with at its new hosting. */
		server: z.string().optional(),
		/** The certificate the first new address presented for the site's name. */
		certificate: certificateSchema.optional(),
		/** Files the case captured that the new hosting served byte for byte. */
		kitFiles: z.array(z.object({ url: z.string(), sha256: z.string() })),
	}),
});
export type HostMove = z.infer<typeof hostMoveSchema>;

/** The moves events record, in the order they were found; the latest record of a move (its content checked again) replaces the earlier. */
export function hostMovesOf(events: ReadonlyArray<{ eventType: string; data: Record<string, unknown> }>): HostMove[] {
	const moves = new Map<string, HostMove>();
	for (const event of events) {
		if (event.eventType !== HOST_MOVED_EVENT) continue;
		const parsed = hostMoveSchema.safeParse(event.data);
		if (!parsed.success) continue;
		moves.delete(parsed.data.key);
		moves.set(parsed.data.key, parsed.data);
	}
	return [...moves.values()];
}

/** "Sollutium-NL (AS43641)", "Cloudflare". */
export function networkLabel(network: Pick<HostMove["to"], "name" | "asn" | "cdn">): string {
	return network.asn !== undefined && !network.cdn ? `${network.name} (AS${network.asn})` : network.name;
}

const WHAT: Record<Locale, (allegation: string | undefined) => string> = {
	en: (allegation) => (allegation === "malware" ? "malware" : allegation === "phishing" ? "the phishing page" : "the reported content"),
	de: (allegation) => (allegation === "malware" ? "Schadsoftware" : allegation === "phishing" ? "die Phishing-Seite" : "die gemeldeten Inhalte"),
};

/** "27 Nov 03:00 UTC" in the page's language. */
function utcTime(at: string, locale: Locale): string {
	const date = new Date(at);
	const day = new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
	return `${day} ${date.toISOString().slice(11, 16)} UTC`;
}

/**
 * One line that says where a reported site went, for the case page and the
 * campaign page alike: "Moved to Sollutium-NL (AS43641) at 26 Nov 21:30 UTC —
 * still serving malware".
 */
export function hostMoveText(move: Pick<HostMove, "at" | "content"> & { to: Pick<HostMove["to"], "name" | "asn" | "cdn"> }, allegation: string | undefined, locale: Locale = "en"): string {
	const where = networkLabel(move.to);
	const when = utcTime(move.at, locale);
	if (locale === "de") {
		const head = `Umgezogen zu ${where} am ${when}`;
		return move.content === "served" ? `${head} – verbreitet weiter ${WHAT.de(allegation)}` : move.content === "gone" ? `${head} – die gemeldeten Inhalte sind dort nicht mehr zu finden` : head;
	}
	const head = `Moved to ${where} at ${when}`;
	return move.content === "served" ? `${head} — still serving ${WHAT.en(allegation)}` : move.content === "gone" ? `${head} — the reported content is no longer there` : head;
}

/** The latest move, when it still served what was reported. */
function servingMove(moves: readonly HostMove[]): HostMove | undefined {
	const latest = moves.at(-1);
	return latest?.content === "served" ? latest : undefined;
}

/**
 * The move that says where a report's site stands now: the latest move, when
 * it still serves what was reported and no later check found the site down.
 */
export function currentMove(moves: readonly HostMove[], latestCheck: { state: SiteCheckState; checkedAt: Date | string } | null | undefined): HostMove | undefined {
	const move = servingMove(moves);
	if (!move || !latestCheck) return move;
	return new Date(latestCheck.checkedAt).getTime() > new Date(move.at).getTime() && !isUp(latestCheck.state) ? undefined : move;
}

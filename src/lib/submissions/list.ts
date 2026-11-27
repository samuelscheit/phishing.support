import { SubmissionsEntity, type SubmissionTileRow } from "@/lib/db/entities/submissions";
import type { SubmissionKind, SubmissionStatus } from "@/lib/db/schema";
import { SUBMISSION_FILTER_NAMES, SUBMISSION_FILTERS, submissionFilterOf, type SubmissionFilter } from "./filters";
import type { ReportedAs } from "./finding";

const SUBMISSION_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/** What the public list shows of one submission. */
export type SubmissionCard = {
	id: string;
	kind: SubmissionKind;
	status: SubmissionStatus;
	createdAt: string;
	title: string;
	/** What a reported case was reported for; absent for every other status. */
	reportedAs?: ReportedAs;
};

/**
 * One tile of the public list: a single submission, a campaign with the
 * listed cases of it (and of its domain still waiting for a visit), or the
 * listed hosts of one site group (a registrable domain such as slon10.to) in
 * no campaign. `newest` is the tile's newest case; the tile opens it unless
 * it is a campaign's.
 */
export type SubmissionListItem =
	| { type: "submission"; key: string; submission: SubmissionCard }
	| {
		type: "campaign";
		key: string;
		campaignId: string;
		newest: SubmissionCard;
		siteCount: number;
		hostCount: number;
		/** The site group every member's case is of, when they share one: the tile names it, with `hostCount`. */
		domain?: string;
		/** The tile's cases still waiting for or in their visit. */
		pending: number;
	}
	| { type: "siteGroup"; key: string; siteGroup: string; newest: SubmissionCard; size: number; runningCount: number; queuedCount: number };

export type SubmissionListPage = {
	items: SubmissionListItem[];
	/** Pass back as `cursor` for the next, older page; absent on the last page. */
	nextCursor?: string;
	/** Every submission counted under its status chip, whatever the filter; on the newest page only. */
	counts?: Record<SubmissionFilter, number>;
};

export class SubmissionCursorError extends Error {
	constructor() {
		super("The submission list cursor is invalid.");
		this.name = "SubmissionCursorError";
	}
}

/** `<createdAt ms>.<id>` of the newest case of the last tile on a page. */
function encodeCursor(row: { createdAt: Date; id: bigint }): string {
	return `${row.createdAt.getTime()}.${row.id.toString()}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: bigint } {
	const match = /^(\d{1,15})\.(\d{1,20})$/.exec(cursor);
	if (!match) throw new SubmissionCursorError();
	return { createdAt: new Date(Number(match[1])), id: BigInt(match[2]!) };
}

async function submissionCounts(): Promise<Record<SubmissionFilter, number>> {
	const counts = Object.fromEntries(SUBMISSION_FILTER_NAMES.map((name) => [name, 0])) as Record<SubmissionFilter, number>;
	for (const { status, count } of await SubmissionsEntity.countByStatus()) counts[submissionFilterOf(status)] += Number(count);
	return counts;
}

function cardOf(row: SubmissionTileRow): SubmissionCard {
	const reportedAs = row.status === "reported" ? row.reportedAs : null;
	return {
		id: row.id.toString(),
		kind: row.kind,
		status: row.status,
		createdAt: row.createdAt.toISOString(),
		title: row.title ?? row.id.toString(),
		...(reportedAs ? { reportedAs } : {}),
	};
}

function itemOf(row: SubmissionTileRow): SubmissionListItem {
	const newest = cardOf(row);
	if (row.campaignId !== null) {
		const campaignId = row.campaignId.toString();
		return {
			type: "campaign",
			key: `campaign-${campaignId}`,
			campaignId,
			newest,
			siteCount: row.campaignSiteCount ?? 0,
			hostCount: row.campaignHostCount ?? 0,
			...(row.campaignDomain ? { domain: row.campaignDomain } : {}),
			pending: row.runningCount + row.queuedCount,
		};
	}
	// A group's lone listed host is a plain card: its other hosts are in a campaign of several domains, or not listed.
	if (row.siteGroup !== null && row.matchedCount > 1) {
		return { type: "siteGroup", key: `site-${row.siteGroup}`, siteGroup: row.siteGroup, newest, size: row.matchedCount, runningCount: row.runningCount, queuedCount: row.queuedCount };
	}
	return { type: "submission", key: newest.id, submission: newest };
}

/**
 * One page of the public submission list's tiles, newest first
 * (`SubmissionsEntity.listTiles`). `filters` keeps the submissions of those
 * status chips (none for an empty list); absent, every submission is listed.
 * Older pages follow with the same filters.
 */
export async function listSubmissionItems(params: { cursor?: string | null; limit?: number; filters?: readonly SubmissionFilter[] } = {}): Promise<SubmissionListPage> {
	const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(params.limit ?? SUBMISSION_PAGE_SIZE)));
	const before = params.cursor ? decodeCursor(params.cursor) : undefined;
	const statuses = params.filters?.flatMap((name) => SUBMISSION_FILTERS[name]);
	const counts = before ? undefined : await submissionCounts();
	// One extra tile tells whether an older page exists without a count query.
	const rows = statuses?.length === 0 ? [] : await SubmissionsEntity.listTiles({ limit: limit + 1, before, statuses });
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map(itemOf),
		...(rows.length > limit && last ? { nextCursor: encodeCursor(last) } : {}),
		...(counts ? { counts } : {}),
	};
}

import { SubmissionsEntity } from "@/lib/db/entities";
import type { SubmissionKind, SubmissionStatus } from "@/lib/db/schema";
import { SUBMISSION_FILTER_NAMES, SUBMISSION_FILTERS, submissionFilterOf, type SubmissionFilter } from "./filters";

export const SUBMISSION_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** What the public list shows for one submission. */
export type SubmissionCard = {
	id: string;
	kind: SubmissionKind;
	status: SubmissionStatus;
	createdAt: string;
	title: string;
	/** The campaign the site belongs to, when it has other sites; the list shows them as one card. */
	campaign?: { id: string; siteCount: number };
};

export type SubmissionCardPage = {
	submissions: SubmissionCard[];
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

/** `<createdAt ms>.<id>` of the last card on a page. */
function encodeCursor(card: { createdAt: Date; id: bigint }): string {
	return `${card.createdAt.getTime()}.${card.id.toString()}`;
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

/**
 * One page of the public submission list, newest first. `filters` keeps the
 * submissions of those status chips (none for an empty list); absent, every
 * submission is listed. Older pages follow with the same filters.
 */
export async function listSubmissionCards(params: { cursor?: string | null; limit?: number; filters?: readonly SubmissionFilter[] } = {}): Promise<SubmissionCardPage> {
	const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(params.limit ?? SUBMISSION_PAGE_SIZE)));
	const before = params.cursor ? decodeCursor(params.cursor) : undefined;
	const statuses = params.filters?.flatMap((name) => SUBMISSION_FILTERS[name]);
	const counts = before ? undefined : await submissionCounts();
	// One extra row tells whether an older page exists without a count query.
	const rows = statuses?.length === 0 ? [] : await SubmissionsEntity.listCards({ limit: limit + 1, before, statuses });
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		submissions: page.map((row) => ({
			id: row.id.toString(),
			kind: row.kind,
			status: row.status,
			createdAt: row.createdAt.toISOString(),
			title: row.title ?? row.id.toString(),
			...(row.campaignId !== null && Number(row.campaignSize) > 1 ? { campaign: { id: row.campaignId.toString(), siteCount: Number(row.campaignSize) } } : {}),
		})),
		...(rows.length > limit && last ? { nextCursor: encodeCursor(last) } : {}),
		...(counts ? { counts } : {}),
	};
}

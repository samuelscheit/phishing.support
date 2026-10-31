import { SubmissionsEntity } from "@/lib/db/entities";
import type { SubmissionKind, SubmissionStatus } from "@/lib/db/schema";

export const SUBMISSION_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** What the public list shows for one submission. */
export type SubmissionCard = {
	id: string;
	kind: SubmissionKind;
	status: SubmissionStatus;
	createdAt: string;
	title: string;
};

export type SubmissionCardPage = {
	submissions: SubmissionCard[];
	/** Pass back as `cursor` for the next, older page; absent on the last page. */
	nextCursor?: string;
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

/** One page of the public submission list, newest first. */
export async function listSubmissionCards(params: { cursor?: string | null; limit?: number } = {}): Promise<SubmissionCardPage> {
	const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(params.limit ?? SUBMISSION_PAGE_SIZE)));
	const before = params.cursor ? decodeCursor(params.cursor) : undefined;
	// One extra row tells whether an older page exists without a count query.
	const rows = await SubmissionsEntity.listCards({ limit: limit + 1, before });
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		submissions: page.map((row) => ({
			id: row.id.toString(),
			kind: row.kind,
			status: row.status,
			createdAt: row.createdAt.toISOString(),
			title: row.title ?? row.id.toString(),
		})),
		...(rows.length > limit && last ? { nextCursor: encodeCursor(last) } : {}),
	};
}

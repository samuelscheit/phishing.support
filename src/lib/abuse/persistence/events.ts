import { asc, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseEvents, type AbuseEvent } from "../schema";
import { recordEvent } from "./shared";

export async function listEvents(reportId: bigint): Promise<AbuseEvent[]> {
	const db = await getDb();
	return db.select().from(abuseEvents).where(eq(abuseEvents.reportId, reportId)).orderBy(asc(abuseEvents.createdAt)).all();
}

/** Append one audit event outside any other write. */
export async function appendEvent(params: Parameters<typeof recordEvent>[1]): Promise<void> {
	const db = await getDb();
	recordEvent(db, params);
}

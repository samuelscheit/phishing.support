import { asc, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseEvents, type AbuseEvent } from "../schema";
import { recordEvent } from "./shared";

export async function listEvents(reportId: bigint): Promise<AbuseEvent[]> {
	const db = await getDb();
	return db.select().from(abuseEvents).where(eq(abuseEvents.reportId, reportId)).orderBy(asc(abuseEvents.createdAt)).all();
}

/** Every event of one type, across reports, oldest first. */
export async function listEventsOfType(eventType: string): Promise<AbuseEvent[]> {
	const db = await getDb();
	return db.select().from(abuseEvents).where(eq(abuseEvents.eventType, eventType)).orderBy(asc(abuseEvents.createdAt)).all();
}

export async function getEvent(id: bigint): Promise<AbuseEvent | undefined> {
	const db = await getDb();
	return db.select().from(abuseEvents).where(eq(abuseEvents.id, id)).get();
}

/** Append one audit event outside any other write. */
export async function appendEvent(params: Parameters<typeof recordEvent>[1]): Promise<void> {
	const db = await getDb();
	recordEvent(db, params);
}

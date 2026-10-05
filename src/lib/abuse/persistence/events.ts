import { asc, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseEvents, type AbuseEvent } from "../schema";

export async function listEvents(reportId: bigint): Promise<AbuseEvent[]> {
	const db = await getDb();
	return db.select().from(abuseEvents).where(eq(abuseEvents.reportId, reportId)).orderBy(asc(abuseEvents.createdAt)).all();
}

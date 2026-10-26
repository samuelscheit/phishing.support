import { and, asc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db";
import { abuseArtifacts, type AbuseArtifact } from "../schema";
import { insertArtifact, type ArtifactValuesParams } from "./shared";

export async function saveArtifact(params: ArtifactValuesParams): Promise<bigint> {
	const db = await getDb();
	return db.transaction((tx) => insertArtifact(tx, params), { behavior: "immediate" });
}

export async function listArtifacts(reportId: bigint, kinds?: string[]): Promise<AbuseArtifact[]> {
	const db = await getDb();
	const where = kinds?.length ? and(eq(abuseArtifacts.reportId, reportId), inArray(abuseArtifacts.kind, kinds)) : eq(abuseArtifacts.reportId, reportId);
	return db.select().from(abuseArtifacts).where(where).orderBy(asc(abuseArtifacts.createdAt)).all();
}

/** Artifact listing for read models; never loads the stored bytes. */
export async function listArtifactMetadata(reportId: bigint) {
	const db = await getDb();
	return db
		.select({ id: abuseArtifacts.id, name: abuseArtifacts.name, kind: abuseArtifacts.kind, mimeType: abuseArtifacts.mimeType, size: abuseArtifacts.size })
		.from(abuseArtifacts)
		.where(eq(abuseArtifacts.reportId, reportId))
		.orderBy(asc(abuseArtifacts.createdAt))
		.all();
}

export async function getArtifact(reportId: bigint, artifactId: bigint): Promise<AbuseArtifact | undefined> {
	const db = await getDb();
	return db.select().from(abuseArtifacts).where(and(eq(abuseArtifacts.reportId, reportId), eq(abuseArtifacts.id, artifactId))).get();
}

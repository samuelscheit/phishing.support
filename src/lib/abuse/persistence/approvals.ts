import { and, asc, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../../db";
import { generateId } from "../../db/ids";
import { abuseJobs, abuseProviderRoutes, abuseReports, type AbuseProviderRoute } from "../schema";
import { recomputeReportStatusInTransaction } from "./report_status";
import { now, recordEvent } from "./shared";

/**
 * A mail drafted for the operator's approval. It is stored on the route and
 * sent exactly as approved; `allowedUrls` are the links the approved text may
 * carry, checked again right before sending.
 */
export type ApprovalDraft = {
	subject: string;
	body: string;
	recipientLabel: string;
	allowedUrls: string[];
};

export function approvalDraftOf(route: Pick<AbuseProviderRoute, "resolutionSnapshot">): ApprovalDraft | undefined {
	const draft = route.resolutionSnapshot?.approvalDraft as Partial<ApprovalDraft> | undefined;
	if (!draft || typeof draft.subject !== "string" || typeof draft.body !== "string" || typeof draft.recipientLabel !== "string") return undefined;
	return {
		subject: draft.subject,
		body: draft.body,
		recipientLabel: draft.recipientLabel,
		allowedUrls: Array.isArray(draft.allowedUrls) ? draft.allowedUrls.filter((url): url is string => typeof url === "string") : [],
	};
}

/** Replace the draft of a mail that still waits for approval; a sent or discarded mail never changes. */
export async function saveApprovalDraft(routeId: bigint, draft: ApprovalDraft): Promise<boolean> {
	const db = await getDb();
	return db.transaction((tx) => {
		const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
		if (!route || route.status !== "awaiting_approval") return false;
		tx.update(abuseProviderRoutes)
			.set({ resolutionSnapshot: { ...route.resolutionSnapshot, approvalDraft: draft }, updatedAt: now() })
			.where(and(eq(abuseProviderRoutes.id, routeId), eq(abuseProviderRoutes.status, "awaiting_approval")))
			.run();
		recordEvent(tx, { reportId: route.reportId, targetId: route.targetId, routeId, eventType: "route.draft_edited", data: {} });
		return true;
	}, { behavior: "immediate" });
}

/**
 * Approve a drafted mail as it now reads: the draft is fixed, the route
 * becomes `verified`, and its delivery job is queued in one transaction, so
 * an approved mail is always sent and an unapproved one never is.
 */
export async function approveDraftedRoute(routeId: bigint, draft: ApprovalDraft): Promise<boolean> {
	const db = await getDb();
	return db.transaction((tx) => {
		const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
		if (!route || route.status !== "awaiting_approval" || route.routeType !== "email" || !route.verifiedEmail) return false;
		const timestamp = now();
		const updated = tx.update(abuseProviderRoutes)
			.set({ resolutionSnapshot: { ...route.resolutionSnapshot, approvalDraft: draft, approvedAt: timestamp.toISOString() }, status: "verified", updatedAt: timestamp })
			.where(and(eq(abuseProviderRoutes.id, routeId), eq(abuseProviderRoutes.status, "awaiting_approval")))
			.returning({ id: abuseProviderRoutes.id })
			.get();
		if (!updated) return false;
		recordEvent(tx, { reportId: route.reportId, targetId: route.targetId, routeId, eventType: "route.status_changed", data: { from: "awaiting_approval", to: "verified", reason: "operator_approved" } });
		const jobId = generateId();
		tx.insert(abuseJobs).values({
			id: jobId,
			jobType: "send_email",
			reportId: route.reportId,
			routeId,
			payload: {},
			dedupeKey: `email:${routeId.toString()}`,
			status: "queued",
			retryCount: 0,
			nextAttemptAt: timestamp,
			unknownExternalState: false,
			createdAt: timestamp,
			updatedAt: timestamp,
		}).run();
		recordEvent(tx, { reportId: route.reportId, routeId, jobId, eventType: "job.queued", data: { jobType: "send_email" } });
		recomputeReportStatusInTransaction(tx, route.reportId, { reason: "operator_approved", routeId: routeId.toString() });
		return true;
	}, { behavior: "immediate" });
}

/**
 * Record the authority's file number for the case a route reported. It is
 * set from a reply or by hand (a letter by post); a later value replaces an
 * earlier one, and every change is in the audit trail.
 */
export async function setCaseReference(routeId: bigint, caseReference: string | null, source: string): Promise<boolean> {
	const db = await getDb();
	return db.transaction((tx) => {
		const route = tx.select().from(abuseProviderRoutes).where(eq(abuseProviderRoutes.id, routeId)).get();
		if (!route) return false;
		const value = caseReference?.trim() || null;
		if (route.caseReference === value) return true;
		tx.update(abuseProviderRoutes).set({ caseReference: value, updatedAt: now() }).where(eq(abuseProviderRoutes.id, routeId)).run();
		recordEvent(tx, { reportId: route.reportId, targetId: route.targetId, routeId, eventType: "route.case_reference_set", data: { from: route.caseReference, to: value, source } });
		return true;
	}, { behavior: "immediate" });
}

/** The referral report of a campaign, if one was opened. */
export async function getCampaignReport(campaignId: bigint) {
	const db = await getDb();
	return db.select().from(abuseReports).where(eq(abuseReports.campaignId, campaignId)).orderBy(asc(abuseReports.createdAt)).get();
}

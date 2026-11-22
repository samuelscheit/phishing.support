import { and, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { asRecord } from "../../util/values";
import { pageScreenshotEvidence } from "../linked_host_report";
import { GENERIC_PROVIDER_FORM_EVIDENCE_CONTRACT } from "../portal/form_task";
import { recomputeReportStatusInTransaction } from "../persistence/report_status";
import { now, recordEvent } from "../persistence/shared";
import { selectProviderEvidenceImageArtifacts } from "../providers/kit/evidence";
import { AbuseRepository } from "../repository";
import { abuseProviderRoutes } from "../schema";

export type GenericPortalRequeue =
	| { requeued: true; runId: string; entryUrl: string; jobId: string; backfilledArtifactId?: string }
	| { requeued: false; reason: string };

/**
 * Tools whose successful use can send a form: a click or key press on any
 * control, or typing that ends with Enter. A run without any of them cannot
 * have filed anything.
 */
function couldHaveSubmitted(action: { tool?: unknown; ok?: unknown; args?: unknown }): boolean {
	if (action.ok !== true) return false;
	if (action.tool === "click" || action.tool === "press") return true;
	return action.tool === "type" && asRecord(action.args)?.submit === true;
}

/**
 * One-off operator repair: send a generic provider-form route back to its
 * form after a run that stopped because it had no screenshot to attach.
 *
 * It refuses unless the route is `needs_human` from exactly such a run: the
 * latest run is a generic provider-form run that failed with the agent's
 * `needs_input`, has no confirmation or submitted target, and its task record
 * shows no action that could have sent the form. An exfiltration-backend
 * report made before those reports carried the page's screenshot gets the
 * confirmed page's screenshot copied from its source report, so the new run
 * has something to attach. The route then re-enters `escalating_to_portal`
 * with a `run_portal` job for the same verified form, whose new run is
 * built from today's adapter (and evidence) under a fresh correlation key.
 */
export async function requeueGenericPortalAfterNeedsInput(routeId: bigint): Promise<GenericPortalRequeue> {
	const route = await AbuseRepository.getRoute(routeId);
	if (!route) return { requeued: false, reason: "route_missing" };
	if (route.status !== "needs_human") return { requeued: false, reason: `route_status_${route.status}` };
	const run = await AbuseRepository.getLatestProviderRunForRoute(route.id);
	const payload = run && asRecord(run.providerPayload);
	if (!run || payload?.adapter !== "generic_verified_provider_form" || !run.correlationKey.startsWith("generic-portal:")) {
		return { requeued: false, reason: "latest_run_not_generic_portal" };
	}
	if (run.executionStatus !== "failed" || !run.failureReason?.startsWith("The agent needs input:")) return { requeued: false, reason: "latest_run_not_needs_input" };
	if (run.confirmationId || run.confirmationText || (run.submittedTargets ?? []).length > 0) return { requeued: false, reason: "latest_run_reported_submission" };
	const entryUrl = typeof payload.entryUrl === "string" ? payload.entryUrl : undefined;
	if (!entryUrl) return { requeued: false, reason: "latest_run_entry_url_missing" };
	const records = (await AbuseRepository.listRouteArtifacts(route.id, ["browser_task_record"])).filter((artifact) => artifact.runId === run.id);
	if (records.length !== 1) return { requeued: false, reason: "task_record_missing" };
	let record: Record<string, unknown> | undefined;
	try {
		record = asRecord(JSON.parse(Buffer.from(records[0]!.blob).toString("utf8")));
	} catch {
		record = undefined;
	}
	const steps = Array.isArray(record?.steps) ? record.steps : undefined;
	if (record?.status !== "needs_input" || !steps) return { requeued: false, reason: "task_record_not_needs_input" };
	const actions = steps.flatMap((step) => {
		const list = asRecord(step)?.actions;
		return Array.isArray(list) ? list.map((action) => asRecord(action) ?? {}) : [{ tool: "unknown", ok: true }];
	});
	if (actions.some(couldHaveSubmitted) || actions.some((action) => action.tool === "unknown")) return { requeued: false, reason: "task_record_shows_possible_submission" };

	const backfilledArtifactId = await backfillSourceScreenshot(route.reportId);
	const reopened = (await getDb()).transaction((tx) => {
		const updated = tx.update(abuseProviderRoutes)
			.set({ status: "escalating_to_portal", updatedAt: now() })
			.where(and(eq(abuseProviderRoutes.id, route.id), eq(abuseProviderRoutes.status, "needs_human")))
			.returning({ id: abuseProviderRoutes.id })
			.get();
		if (!updated) return false;
		recordEvent(tx, {
			reportId: route.reportId,
			targetId: route.targetId,
			routeId: route.id,
			runId: run.id,
			eventType: "route.status_changed",
			data: { from: "needs_human", to: "escalating_to_portal", reason: "operator_requeue_generic_portal_needs_input", providerLink: entryUrl },
		});
		recomputeReportStatusInTransaction(tx, route.reportId, { reason: "route_status_transition", routeId: route.id.toString() });
		return true;
	}, { behavior: "immediate" });
	if (!reopened) return { requeued: false, reason: "route_changed_concurrently" };
	const job = await AbuseRepository.enqueueJob({
		jobType: "run_portal",
		reportId: route.reportId,
		routeId: route.id,
		payload: { providerLink: entryUrl, requeuedFromRunId: run.id.toString() },
		dedupeKey: `generic-portal:${route.id.toString()}`,
	});
	return { requeued: true, runId: run.id.toString(), entryUrl, jobId: job.id.toString(), ...(backfilledArtifactId ? { backfilledArtifactId } : {}) };
}

/**
 * An exfiltration-backend report without a screenshot of its own gets the
 * confirmed page's screenshot from the report it was found by, exactly as
 * such reports now carry it from the start (`lure-page.png`).
 */
async function backfillSourceScreenshot(reportId: bigint): Promise<string | undefined> {
	const own = await AbuseRepository.listArtifacts(reportId, ["user_evidence_original"]);
	if (selectProviderEvidenceImageArtifacts(own, GENERIC_PROVIDER_FORM_EVIDENCE_CONTRACT, 1).length) return undefined;
	const [original] = await AbuseRepository.listArtifacts(reportId, ["original_request"]);
	let request: Record<string, unknown> | undefined;
	try {
		request = original ? asRecord(JSON.parse(Buffer.from(original.blob).toString("utf8"))) : undefined;
	} catch {
		request = undefined;
	}
	if (request?.kind !== "exfiltration_backend" || typeof request.sourceReportId !== "string" || !/^\d+$/.test(request.sourceReportId)) return undefined;
	const sourceArtifacts = await AbuseRepository.listArtifacts(BigInt(request.sourceReportId), ["user_evidence_original"]);
	const [reference] = selectProviderEvidenceImageArtifacts(sourceArtifacts, GENERIC_PROVIDER_FORM_EVIDENCE_CONTRACT, 1);
	const source = reference && sourceArtifacts.find((artifact) => artifact.id.toString() === reference.artifactId);
	if (!reference || !source) return undefined;
	const evidence = pageScreenshotEvidence({ buffer: Buffer.from(source.blob), mimeType: reference.mimeType });
	const id = await AbuseRepository.saveArtifact({
		reportId,
		name: evidence.filename,
		kind: "user_evidence_original",
		mimeType: evidence.mimeType,
		buffer: evidence.buffer,
		metadata: { source: "source_report_screenshot_backfill", sourceReportId: request.sourceReportId, sourceArtifactId: reference.artifactId, decodedMimeType: evidence.mimeType },
	});
	return id.toString();
}

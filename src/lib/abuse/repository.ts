/**
 * Abuse persistence is intentionally organized by durable operation, not by
 * table. Each implementation owns the cross-table transaction that protects a
 * lifecycle transition or external side-effect boundary. This composition is
 * only an import surface for higher-level use cases; it contains no database
 * behavior. The implementation lives in the focused modules under
 * `persistence/`.
 */
import {
	getArtifact,
	getArtifactById,
	listArtifacts,
	saveArtifact,
} from "./persistence/artifacts";
import {
	beginEmailDelivery,
	recoverEmailPreparationFailure,
	settleCorrelatedEmailBounce,
	settleEmailDelivery,
} from "./persistence/email_delivery";
import { listEvents } from "./persistence/events";
import {
	claimNextJob,
	completeJob,
	enqueueJob,
	failJob,
	markJobUnknownExternalState,
	recoverStaleJobs,
	renewJobLease,
	retryJob,
} from "./persistence/jobs";
import { releaseLock, renewLock, tryAcquireLock } from "./persistence/locks";
import {
	createOutboundMail,
	ensureInboundReplyClassification,
	findCorrelatedInboundRoute,
	getInboundMailByImap,
	getInboundMailByMessageId,
	getMailMessage,
	getOutboundMailForRun,
	listMailForReport,
	persistInboundMailWithArtifacts,
	setMailClassification,
	settleOutboundMail,
} from "./persistence/mail";
import { beginProviderExecution } from "./persistence/provider_execution";
import {
	createProviderRun,
	getLatestActiveProviderRunForRoute,
	getLatestProviderRunForRoute,
	getProviderRun,
	getProviderRunByCorrelationKey,
	getProviderRunBySkyvernRunId,
	listProviderRunsForReport,
	prepareProviderSubmission,
	prepareSkyvernTaskCreation,
	recordSkyvernTaskStarted,
	settleProviderRun,
	updateProviderRun,
} from "./persistence/provider_runs";
import { getPublicStatus } from "./persistence/public_status";
import {
	createReport,
	getReport,
	getReportByIdempotencyKey,
	getReportByTrackingToken,
	getReportByTrackingTokenHash,
	getReportInput,
	getRoute,
	getTarget,
	listRoutes,
	listTargets,
	setReportStatus,
	setReportVerificationOutcome,
	transitionReportStatus,
} from "./persistence/reports";
import { recomputeReportStatus } from "./persistence/report_status";
import {
	markUnknownExternalState,
	setRouteStatus,
	setRouteVerification,
	setTargetResolution,
	transitionRouteStatus,
	upsertResolvedRoute,
} from "./persistence/routes";
import {
	enqueueReconciliationForSkyvernRun,
	persistWebhook,
} from "./persistence/webhooks";

export type { CreatedAbuseReport } from "./persistence/reports";
export type { ResolvedRouteInput } from "./route_contracts";
export { aggregateReportStatus } from "./persistence/state";

export const AbuseRepository = {
	createReport,
	getReport,
	getReportByTrackingTokenHash,
	getReportByTrackingToken,
	getReportByIdempotencyKey,
	listTargets,
	listRoutes,
	getRoute,
	getTarget,
	getReportInput,
	setReportVerificationOutcome,
	transitionReportStatus,
	setReportStatus,
	setTargetResolution,
	upsertResolvedRoute,
	transitionRouteStatus,
	setRouteStatus,
	markUnknownExternalState,
	setRouteVerification,
	createProviderRun,
	getProviderRun,
	getProviderRunBySkyvernRunId,
	getProviderRunByCorrelationKey,
	listProviderRunsForReport,
	getLatestProviderRunForRoute,
	getLatestActiveProviderRunForRoute,
	updateProviderRun,
	settleProviderRun,
	beginProviderExecution,
	beginEmailDelivery,
	prepareProviderSubmission,
	prepareSkyvernTaskCreation,
	recordSkyvernTaskStarted,
	settleEmailDelivery,
	recoverEmailPreparationFailure,
	settleCorrelatedEmailBounce,
	saveArtifact,
	listArtifacts,
	getArtifact,
	getArtifactById,
	enqueueJob,
	claimNextJob,
	renewJobLease,
	completeJob,
	retryJob,
	markJobUnknownExternalState,
	failJob,
	recoverStaleJobs,
	tryAcquireLock,
	releaseLock,
	renewLock,
	createOutboundMail,
	ensureInboundReplyClassification,
	settleOutboundMail,
	getOutboundMailForRun,
	listMailForReport,
	findCorrelatedInboundRoute,
	persistInboundMailWithArtifacts,
	getMailMessage,
	getInboundMailByImap,
	getInboundMailByMessageId,
	setMailClassification,
	persistWebhook,
	enqueueReconciliationForSkyvernRun,
	listEvents,
	recomputeReportStatus,
	getPublicStatus,
};

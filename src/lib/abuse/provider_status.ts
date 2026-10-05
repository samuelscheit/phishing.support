/** The lifecycle fields exposed by the submission detail read model. */
export type ProviderReportLifecycle = {
	status: string;
	executionStatus?: string | null;
	error?: string | null;
};

/**
 * Explain the difference between a verified route, local preparation, and a
 * provider-confirmed submission. A single generic "not completed" message
 * used to hide all of those materially different states.
 */
export function describeProviderReportStatus(report: ProviderReportLifecycle): string {
	const status = report.status.trim().toLowerCase();
	const executionStatus = report.executionStatus?.trim().toLowerCase();

	switch (status) {
		case "submitted":
		case "acknowledged":
			return "The provider confirmed that it received this report.";
		case "provider_rejected":
			return report.error || "The provider explicitly rejected this report.";
		case "insufficient_evidence":
			return report.error || "The stored evidence did not satisfy this provider's submission requirements.";
		case "unknown_external_state":
			return "The provider request may have crossed its submission boundary, but its outcome could not be verified safely. It was not retried automatically.";
		case "needs_human":
			return report.error || "Automatic submission stopped because this provider's form or safety contract needs human review.";
		case "failed":
			return report.error || "Local provider processing failed before a confirmed submission.";
		case "delivery_failed":
			return report.error || "The provider report could not be delivered.";
		case "resolving":
			return "The service is still resolving and verifying the provider route.";
		case "verified":
			return "The provider route is verified. The provider-specific report is queued; no request has been sent yet.";
		case "queued":
			return "The provider-specific report is queued. No request has been sent yet.";
		case "running":
			if (executionStatus === "starting" || executionStatus === "pending") {
				return "The provider-specific report is being prepared, including any required provider verification. No request has been sent yet.";
			}
			if (executionStatus === "submission_started") {
				return "The provider request has started. Provider receipt has not been confirmed yet.";
			}
			if (executionStatus) return `The provider-specific report is in the ${executionStatus.replaceAll("_", " ")} phase. Provider receipt has not been confirmed yet.`;
			return "The provider-specific report is being submitted. Provider receipt has not been confirmed yet.";
		case "waiting_code":
			return "The provider requires a verification code before the report can be submitted.";
		case "awaiting_provider_reply":
			return "The report was delivered to the provider. The service is waiting for a provider reply.";
		case "escalating_to_portal":
			return "The report is being escalated to the provider's reporting portal.";
		case "no_route":
			return report.error || "No verified provider reporting route was available.";
		default:
			return report.error || "The provider report has not reached a terminal state.";
	}
}

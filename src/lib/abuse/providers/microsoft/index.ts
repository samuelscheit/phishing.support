import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { MICROSOFT_PROVIDER } from "./definition";
import { makeMicrosoftNotes, microsoftReportUrls } from "./payload";
import { prepareMicrosoftSubmission, submitMicrosoftSubmission } from "./submission";

/**
 * abuse@ and cert@microsoft.com are unmonitored; the route files the report
 * through MSRC Report Abuse. Microsoft documents no confirmation mail or
 * status endpoint, so there is no inbound mail rule: the run's receipt is the
 * accepted request.
 */
export const microsoftProvider: ProviderSubmissionProvider = {
	definition: MICROSOFT_PROVIDER,
	prepareSubmission: (context) => prepareMicrosoftSubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "microsoft_msrc_report_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => {
		const urls = microsoftReportUrls(context.target, context.observedUrls);
		return urls ? makeMicrosoftNotes({
			target: context.target,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			reference: "PS-000000000000-R0",
		}, urls) : undefined;
	},
	submit: (context) => submitMicrosoftSubmission(context),
};


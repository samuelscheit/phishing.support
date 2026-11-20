import { defineProvider, PREVIEW_REFERENCE } from "../kit/provider";
import { MICROSOFT_PROVIDER } from "./definition";
import { makeMicrosoftNotes, microsoftReportUrls } from "./payload";
import { prepareMicrosoftSubmission, submitMicrosoftSubmission } from "./submission";

/**
 * abuse@ and cert@microsoft.com are unmonitored; the route files the report
 * through MSRC Report Abuse. Microsoft documents no confirmation mail or
 * status endpoint, so there is no inbound mail rule: the run's receipt is the
 * accepted request.
 */
export const microsoftProvider = defineProvider({
	definition: MICROSOFT_PROVIDER,
	prepare: prepareMicrosoftSubmission,
	preview: (context) => {
		const urls = microsoftReportUrls(context.target, context.observedUrls);
		return urls ? makeMicrosoftNotes({
			target: context.target,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: PREVIEW_REFERENCE,
		}, urls) : undefined;
	},
	submit: (context) => submitMicrosoftSubmission(context),
});

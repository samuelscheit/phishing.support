import type { ProviderReportPreviewContext, ProviderSubmissionProvider } from "../submission_contracts";
import { AWS_PROVIDER } from "./definition";
import { awsReportUrls, awsTrackingIdsIn, makeAwsComments } from "./payload";
import { prepareAwsSubmission, submitAwsSubmission } from "./submission";

/**
 * AWS's abuse mailboxes answer with a pointer to its web form; the route files
 * the report there. AWS's case mail goes to the service mailbox, quotes our
 * reference, and can ask for more, so it is read as a reply, not a receipt.
 */
export const awsProvider: ProviderSubmissionProvider = {
	definition: AWS_PROVIDER,
	prepareSubmission: (context) => prepareAwsSubmission(context),
	shouldRefreshStartingPayload: (context) => context.payload.adapter !== "aws_report_v1" || context.payload.providerNarrativeVersion !== 1,
	buildReportPreview: (context: ProviderReportPreviewContext) => {
		const urls = awsReportUrls(context.target, context.observedUrls);
		return urls ? makeAwsComments({
			target: context.target,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: "PS-000000000000-R0",
		}, urls) : undefined;
	},
	submit: (context) => submitAwsSubmission(context),
	inboundMail: {
		// support.aws.com: "Your AWS Abuse Report [P01M7…]" from trustandsafety@support.aws.com.
		senderDomains: ["aws.com"],
		confirmationIds: awsTrackingIdsIn,
		messageKind: "reply",
	},
};

export { AWS_PROVIDER } from "./definition";

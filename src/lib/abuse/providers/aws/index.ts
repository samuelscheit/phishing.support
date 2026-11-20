import { defineProvider, PREVIEW_REFERENCE } from "../kit/provider";
import { AWS_PROVIDER } from "./definition";
import { awsReportUrls, makeAwsComments } from "./payload";
import { awsDraft, submitAwsSubmission } from "./submission";

/**
 * AWS's abuse mailboxes answer with a pointer to its web form; the route files
 * the report there. AWS's case mail goes to the service mailbox, quotes our
 * reference, and can ask for more, so it is read as a reply, not a receipt.
 */
export const awsProvider = defineProvider({
	definition: AWS_PROVIDER,
	draft: awsDraft,
	preview: (context) => {
		const urls = awsReportUrls(context.target, context.observedUrls);
		return urls ? makeAwsComments({
			target: context.target,
			observedUrls: context.observedUrls,
			description: context.description,
			...(context.allegationCategory ? { allegationCategory: context.allegationCategory } : {}),
			legalBrandUrl: context.legalBrandUrl ?? null,
			trackingId: PREVIEW_REFERENCE,
		}, urls) : undefined;
	},
	submit: submitAwsSubmission,
	// support.aws.com: "Your AWS Abuse Report [P01M7…]" from trustandsafety@support.aws.com.
	inbound: { messageKind: "reply", senderDomains: ["aws.com"] },
});

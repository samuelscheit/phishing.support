export {
	abuseReplyClassifications,
	abuseReplyClassificationSchema,
	isSafeEmailDeliveryFailure,
	SafeEmailDeliveryFailure,
} from "./mail/types";
export type {
	AbuseMailAttachment,
	AbuseMailSendResult,
	AbuseMailTransport,
	AbuseReplyClassification,
	CanonicalAbuseMail,
} from "./mail/types";

export { extractUnambiguousVerificationCode } from "./mail/shared";

export { buildCanonicalAbuseMail, sendAbuseEmailRoute } from "./mail/send";

export {
	abuseEmailCaseUrl,
	abuseEmailRecipientLabel,
	createAbuseEmailDraft,
	hasSubstantialCopiedPassage,
	readVerifiedEmailDraft,
	verifiedEmailProviderPayload,
} from "./mail/draft";
export type { AbuseEmailDraft, AbuseEmailDraftDependencies, AbuseEmailSummaryInput, VerifiedEmailProviderPayload } from "./mail/draft";

export {
	classifyProviderReply,
	classifyProviderReplyWithAI,
	extractVerifiedProviderLinks,
	resolveVerifiedProviderLink,
} from "./mail/reply";
export type { ProviderLinkFetch, VerifiedProviderLinkResolution } from "./mail/reply";

export { persistInboundAbuseMail } from "./mail/inbound";

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
	classifyProviderReply,
	classifyProviderReplyWithAI,
	extractVerifiedProviderLinks,
	resolveVerifiedProviderLink,
} from "./mail/reply";
export type { ProviderLinkFetch, VerifiedProviderLinkResolution } from "./mail/reply";

export { persistInboundAbuseMail } from "./mail/inbound";

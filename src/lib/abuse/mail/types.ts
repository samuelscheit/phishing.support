import { z } from "zod";

export const abuseReplyClassifications = [
	"acknowledged",
	"not_monitored",
	"needs_more_information",
	"rejected",
	"bounce",
	"ambiguous",
] as const;

export const abuseReplyClassificationSchema = z
	.object({
		classification: z.enum(abuseReplyClassifications),
		confidence: z.number().min(0).max(1),
		rationale: z.string().max(2_000),
	})
	.strict();

export type AbuseReplyClassification = z.infer<typeof abuseReplyClassificationSchema>;

export type AbuseMailAttachment = {
	filename: string;
	mimeType: string;
	content: Buffer;
};

export type AbuseMailTransport = {
	sendMail(params: { raw: Buffer; envelope: { from: string; to: string[] } }): Promise<{ messageId?: string }>;
};

export type AbuseMailSendResult = {
	messageId: bigint;
	status: "sent" | "failed" | "unknown_external_state";
	error?: string;
	rfcMessageId: string;
};

/**
 * A retryable failure that is durably known to have happened before the
 * provider could accept the message. This is deliberately distinct from an
 * arbitrary exception: once SMTP has returned success, a later local database
 * failure is ambiguous and must never be retried as if no message was sent.
 */
export class SafeEmailDeliveryFailure extends Error {
	readonly safeToRetry = true;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SafeEmailDeliveryFailure";
	}
}

export function isSafeEmailDeliveryFailure(error: unknown): error is SafeEmailDeliveryFailure {
	return error instanceof SafeEmailDeliveryFailure
		|| (Boolean(error) && typeof error === "object" && (error as { safeToRetry?: unknown }).safeToRetry === true);
}

export type CanonicalAbuseMail = {
	from: string;
	to: string[];
	subject: string;
	textBody: string;
	replyAddress: string;
	correlationKey: string;
	messageId: string;
	rawMime: Buffer;
};

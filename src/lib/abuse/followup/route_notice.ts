import { errorText as describeError } from "../../util/error_text";
import { sendAbuseEmailRoute } from "../mail/send";
import { getProviderSubmissionProvider } from "../providers";
import { ProviderSubmissionRejectedError, type DecisionAnswerChannel } from "../providers/submission_contracts";
import { AbuseRepository } from "../repository";
import type { AbuseProviderRoute } from "../schema";
import { UnknownExternalStateError } from "../worker/shared";
import type { AttachableFile } from "./tools";

/** A message on a route after its report: an answer to the provider's decision, or news about the reported site. */
export type RouteMessage = {
	route: Pick<AbuseProviderRoute, "id" | "reportId">;
	runId: bigint;
	confirmationId: string;
	subject: string;
	body: string;
	attachments: AttachableFile[];
	/** The message's idempotency marker: its outbound record carries it, so it is never sent twice. */
	correlationKey: string;
};

/** Mail the message; its outbound record, under its correlation key, keeps it from being sent twice. */
export async function messageByMail(message: RouteMessage & { recipient: string }, send: typeof sendAbuseEmailRoute = sendAbuseEmailRoute): Promise<string | null> {
	const result = await send({
		routeId: message.route.id,
		runId: message.runId,
		reportId: message.route.reportId,
		recipient: message.recipient,
		subject: message.subject,
		body: message.body,
		attachments: message.attachments,
		correlationKey: message.correlationKey,
	});
	if (result.status === "unknown_external_state") throw new UnknownExternalStateError(`The message to ${message.recipient} may have been sent: ${result.error ?? "SMTP outcome unknown"}`);
	if (result.status !== "sent") throw new Error(`The message to ${message.recipient} was not sent: ${result.error ?? "SMTP failure"}`);
	return result.rfcMessageId ?? null;
}

/**
 * File the message through the provider's form. Its record is written right
 * before the request that files it, under its correlation key: a failure
 * before that is retried by the job, a failure of that request is never
 * repeated, and a named refusal settles the record as failed.
 */
export async function messageThroughForm(message: RouteMessage & { channel: Extract<DecisionAnswerChannel, { kind: "form" }> }): Promise<string> {
	let recorded: bigint | undefined;
	const markSending = async () => {
		recorded = await AbuseRepository.createOutboundProviderMessage({
			reportId: message.route.reportId,
			routeId: message.route.id,
			runId: message.runId,
			to: message.channel.name,
			subject: message.subject,
			textBody: message.body,
			correlationKey: message.correlationKey,
		});
	};
	try {
		await message.channel.submit({ confirmationId: message.confirmationId, body: message.body, attachments: message.attachments }, markSending);
	} catch (error) {
		if (recorded === undefined) throw error;
		if (error instanceof ProviderSubmissionRejectedError) {
			await AbuseRepository.settleOutboundMail({ messageId: recorded, status: "failed", error: describeError(error) });
			throw error;
		}
		throw new UnknownExternalStateError(`The message through ${message.channel.name} may have been filed: ${describeError(error)}`);
	}
	if (recorded === undefined) throw new Error(`${message.channel.name} filed the message without recording it first.`);
	await AbuseRepository.settleOutboundMail({ messageId: recorded, status: "sent" });
	return recorded.toString();
}

/**
 * Where a route takes more evidence after its report, as the provider
 * itself named it: the mailbox a mail report went to (a reply to that
 * report), or the follow-up channel of a provider that defines one
 * (Cloudflare's abusereply@cloudflare.com, Eranet's supplement form) with
 * the receipt it names the report by. Undefined for a provider without one,
 * or a report not delivered yet.
 */
type NoticeChannel =
	| { kind: "email"; recipient: string; subject: string; runId: bigint; confirmationId: string }
	| { kind: "form"; channel: Extract<DecisionAnswerChannel, { kind: "form" }>; subject: string; runId: bigint; confirmationId: string };

async function noticeChannelOf(route: AbuseProviderRoute, providerFor: typeof getProviderSubmissionProvider = getProviderSubmissionProvider): Promise<NoticeChannel | undefined> {
	const run = await AbuseRepository.getLatestProviderRunForRoute(route.id);
	if (!run) return undefined;
	if (route.routeType === "email" && route.verifiedEmail) {
		const report = (await AbuseRepository.listMailForReport(route.reportId))
			.find((message) => message.routeId === route.id && message.direction === "outbound" && message.status === "sent" && message.correlationKey === `email-run:${route.id.toString()}`);
		if (!report?.subject) return undefined;
		const subject = /^re:/i.test(report.subject) ? report.subject : `Re: ${report.subject}`;
		return { kind: "email", recipient: route.verifiedEmail, subject, runId: run.id, confirmationId: report.messageId ?? run.correlationKey };
	}
	const channel = route.routeType === "provider_submission" ? providerFor(route.providerRegistryKey)?.decisionFollowUp?.channel : undefined;
	if (!channel || !run.confirmationId) return undefined;
	return channel.kind === "email"
		? { kind: "email", recipient: channel.replyAddress, subject: channel.subject(run.confirmationId), runId: run.id, confirmationId: run.confirmationId }
		: { kind: "form", channel, subject: `Additional evidence for report ${run.confirmationId}`, runId: run.id, confirmationId: run.confirmationId };
}

export type NoticeOutcome = { status: "sent"; to: string; messageId: string | null } | { status: "already_sent" } | { status: "no_channel" };

/**
 * Send news about the reported site on a route through its channel, once
 * per correlation key: a message already recorded under the key (sent,
 * failed, or in flight) is never sent again.
 */
export async function sendRouteNotice(
	route: AbuseProviderRoute,
	notice: { body: string; attachments: AttachableFile[]; correlationKey: string },
	dependencies: { send?: typeof sendAbuseEmailRoute; providerFor?: typeof getProviderSubmissionProvider } = {},
): Promise<NoticeOutcome> {
	const mail = await AbuseRepository.listMailForReport(route.reportId);
	if (mail.some((message) => message.direction === "outbound" && message.correlationKey === notice.correlationKey)) return { status: "already_sent" };
	const channel = await noticeChannelOf(route, dependencies.providerFor);
	if (!channel) return { status: "no_channel" };
	const message = { route, runId: channel.runId, confirmationId: channel.confirmationId, subject: channel.subject, ...notice };
	if (channel.kind === "email") return { status: "sent", to: channel.recipient, messageId: await messageByMail({ ...message, recipient: channel.recipient }, dependencies.send) };
	return { status: "sent", to: channel.channel.name, messageId: await messageThroughForm({ ...message, channel: channel.channel }) };
}

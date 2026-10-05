import { getMailMessage } from "../../persistence/mail";
import { enqueueJob } from "../../persistence/jobs";
import { getRoute } from "../../persistence/reports";
import type { ProviderInboxCandidate, StoredProviderInboxMessage } from "../contracts";
import { activeGnameRouteIdentity, configuredGnameMailbox } from "./identity";
import { gnameVerificationCodeFromMessage, storedGnameSenderAddresses } from "./inbound_policy";
import { getSoleWaitingCodeRoute } from "./persistence/mailbox";
import { getLatestGnameActiveRunForRoute } from "./persistence/runs";

/**
 * Match only a GNAME verification message addressed to the one configured
 * shared mailbox. Explicit Reply-To/RFC-message-ID correlation is evaluated
 * first by generic IMAP ingestion; this matcher is only the unambiguous
 * provider-specific fallback.
 */
export async function findGnameInboundRoute(candidate: ProviderInboxCandidate) {
	const mailbox = configuredGnameMailbox();
	if (!mailbox || !gnameVerificationCodeFromMessage({ ...candidate, mailbox })) return undefined;
	const route = await getSoleWaitingCodeRoute();
	return route && activeGnameRouteIdentity(route)?.mailbox === mailbox ? route : undefined;
}

/**
 * Re-read the durable route and MIME record after storage before queuing a
 * code-delivery job. The inbound parser's transient match is never enough to
 * authorize an irreversible SDK action, and the message-specific dedupe key
 * prevents a repeated IMAP delivery from replaying the same code.
 */
export async function onGnameInboundMessageStored(message: StoredProviderInboxMessage): Promise<void> {
	const [route, mail] = await Promise.all([getRoute(message.routeId), getMailMessage(message.messageId)]);
	const identity = route ? activeGnameRouteIdentity(route) : undefined;
	if (
		!route
		|| route.reportId !== message.reportId
		|| route.providerRegistryKey !== "gname"
		|| route.status !== "waiting_code"
		|| !identity
		|| !mail
		|| mail.reportId !== route.reportId
		|| mail.routeId !== route.id
		|| mail.direction !== "inbound"
		|| !gnameVerificationCodeFromMessage({
			senderAddresses: storedGnameSenderAddresses(mail.fromAddress),
			recipients: mail.toAddresses,
			textBody: mail.textBody ?? "",
			mailbox: identity.mailbox,
		})
	) {
		return;
	}
	const run = await getLatestGnameActiveRunForRoute(route.id);
	if (!run?.skyvernRunId || run.reportId !== route.reportId || run.routeId !== route.id || run.executionStatus !== "waiting_code") return;
	await enqueueJob({
		jobType: "deliver_provider_verification_code",
		reportId: route.reportId,
		routeId: route.id,
		runId: run.id,
		payload: {
			messageId: mail.id.toString(),
		},
		dedupeKey: `deliver-provider-code:${route.providerRegistryKey}:${route.id.toString()}:${mail.id.toString()}`,
	});
}

import { simpleParser } from "mailparser";

import { deliveryFailure, deliveryReport } from "../mail/delivery_report";
import { isRelayRefusal } from "../mail/relay_refusal";
import { AbuseRepository } from "../repository";
import type { AbuseMailMessage } from "../schema";
import { classifyReply } from "./mail";

export type MisreadBounceRepair = {
	routeId: string;
	verifiedEmail: string | null;
	/** `repaired`: the route's last send settled as permanently bounced; `skipped`: left as it was, for `reason`. */
	result: "repaired" | "skipped";
	reason?: "no_permanent_failure_of_last_send" | "route_changed";
	/** The route's status afterwards. */
	status: string;
	/** The next abuse contact the report moved on to, when the target has one. */
	nextContact?: string;
};

/**
 * One-off repair, idempotent: routes that a delivery report, taken for a
 * reply, ended as `provider_rejected` ("uncorrelated_provider_bounce").
 * Until ingestion read every delivery report as a bounce
 * (mail/delivery_report.ts), Exchange's non-delivery reports, threaded to the
 * returned mail by In-Reply-To, reached the reply classifier. Its "bounce"
 * resent the report every minute, and a replayed classification of an old
 * notice ended the route (ip.abuse@tatatel.co.in, 2026-11-20: 43 sends).
 *
 * Each such route whose last send a stored raw delivery report permanently
 * failed is reopened with all its delivery reports stored as bounces, and the
 * report for the last send is settled like any bounce now: the route fails and
 * the report moves on to the target's next abuse contact. Other routes (our
 * relay's refusals, routes whose last send no report failed) are left alone.
 * A rerun finds no such route left.
 */
export async function repairMisreadBounces(): Promise<MisreadBounceRepair[]> {
	const repairs: MisreadBounceRepair[] = [];
	for (const route of await AbuseRepository.listRoutesEndedByUncorrelatedBounce()) {
		const mail = (await AbuseRepository.listMailForReport(route.reportId))
			.filter((message) => message.routeId === route.id)
			.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
		const lastSend = mail.filter((message) => message.direction === "outbound" && message.messageId).at(-1);
		const bounces = await storedDeliveryReports(mail.filter((message) => message.direction === "inbound"));
		const settling = bounces.filter((bounce) => {
			const text = bounce.message.textBody ?? "";
			return bounce.references.includes(lastSend?.messageId ?? "") && !isRelayRefusal(text) && deliveryReport(text).outcome === "permanent";
		}).at(-1);
		const outcome = { routeId: route.id.toString(), verifiedEmail: route.verifiedEmail };
		if (!settling) {
			repairs.push({ ...outcome, result: "skipped", reason: "no_permanent_failure_of_last_send", status: route.status });
			continue;
		}
		const misread = bounces.filter((bounce) => bounce.message.kind !== "bounce").map((bounce) => ({ messageId: bounce.message.id, references: bounce.references }));
		if (!await AbuseRepository.reopenRouteForMisreadBounces({ routeId: route.id, bounces: misread })) {
			repairs.push({ ...outcome, result: "skipped", reason: "route_changed", status: (await AbuseRepository.getRoute(route.id))?.status ?? "deleted" });
			continue;
		}
		await classifyReply(settling.message.id);
		const next = (await AbuseRepository.listRoutes(route.reportId)).find((other) => other.resolverProvenance.bouncedRouteId === route.id.toString());
		repairs.push({
			...outcome,
			result: "repaired",
			status: (await AbuseRepository.getRoute(route.id))?.status ?? "deleted",
			...(next?.verifiedEmail ? { nextContact: next.verifiedEmail } : {}),
		});
	}
	return repairs;
}

/** The inbound messages whose raw MIME is a delivery report, with every send of ours each names. */
async function storedDeliveryReports(inbound: AbuseMailMessage[]): Promise<Array<{ message: AbuseMailMessage; references: string[] }>> {
	const reports: Array<{ message: AbuseMailMessage; references: string[] }> = [];
	for (const message of inbound) {
		const raw = message.rawArtifactId ? await AbuseRepository.getArtifact(message.reportId, message.rawArtifactId) : undefined;
		const failure = raw ? deliveryFailure(await simpleParser(raw.blob)) : undefined;
		if (!failure) continue;
		const references = [...new Set([...failure.messageIds, ...[message.inReplyTo, ...message.references].filter((id): id is string => Boolean(id)).map((id) => id.toLowerCase())])];
		reports.push({ message, references });
	}
	return reports;
}

import { serviceIdentity } from "../../network/service_identity";
import { readVerifiedEmailDraft, verifiedEmailProviderPayload } from "../mail/draft";
import { approvalDraftOf, type ApprovalDraft } from "../persistence/approvals";
import { AbuseRepository } from "../repository";
import type { AbuseProviderRoute } from "../schema";

/**
 * Mails nothing sends on its own: criminal referrals, preservation notices,
 * and escalations to oversight bodies (`abuse/escalation`). Each is a route
 * of its report that waits in `awaiting_approval` with its draft; the
 * operator edits, approves or discards it, and an approved draft is sent
 * exactly as approved by the route's normal mail delivery.
 */

/** An operator action the mail's state refuses; the operator page shows its message as it is. */
export class OperatorActionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OperatorActionError";
	}
}

const URL_IN_TEXT = /https?:\/\/[^\s<>'"`]+/gi;

function urlsIn(text: string): string[] {
	return [...new Set((text.match(URL_IN_TEXT) ?? []).map((url) => url.replace(/[),.;!?]+$/, "")))];
}

/** Store a drafted mail as a route of the report that waits for the operator's approval. */
export async function draftMailRoute(params: {
	targetId: bigint;
	routeKey: string;
	registryKey: string;
	recipient: string;
	recipientLabel: string;
	draft: { subject: string; body: string };
	provenance: Record<string, unknown>;
	/** What else the route's snapshot keeps: what kind of mail it is and what it covers. */
	snapshot: Record<string, unknown>;
}): Promise<AbuseProviderRoute> {
	const approvalDraft: ApprovalDraft = { ...params.draft, recipientLabel: params.recipientLabel, allowedUrls: urlsIn(params.draft.body) };
	const route = await AbuseRepository.upsertResolvedRoute(params.targetId, {
		routeKey: params.routeKey,
		providerRegistryKey: params.registryKey,
		providerDisplayName: params.recipientLabel,
		routeType: "email",
		verifiedEmail: params.recipient,
		resolverProvenance: params.provenance,
		resolutionSnapshot: { ...params.snapshot, approvalDraft },
		status: "awaiting_approval",
	});
	await AbuseRepository.recomputeReportStatus(route.reportId);
	return route;
}

/** A drafted mail waiting for approval, as the approvals page shows it. */
export type DraftedMailView = {
	routeId: string;
	/** What the mail is: an escalation's (`cert`, `dsa_notice`, `brand`) or a referral's (`complaint`, `supplement`, `preservation_notice`). */
	kind: string;
	recipient: string;
	recipientLabel: string;
	subject: string;
	body: string;
	target: string;
	createdAt: string;
	/** Why the mail goes to its recipient, when the draft says so (escalations). */
	reason?: string;
	/** Where the mail's context is: the case of an escalation, the campaign of a referral (with its attachments). */
	context?: { href: string; label: "case" | "campaign" };
};

/** Every drafted mail waiting for the operator, oldest first. */
export async function listDraftedMails(): Promise<DraftedMailView[]> {
	const views: DraftedMailView[] = [];
	for (const route of await AbuseRepository.listRoutesAwaitingApproval()) {
		const draft = approvalDraftOf(route);
		if (!draft || !route.verifiedEmail) continue;
		const [report, target] = await Promise.all([AbuseRepository.getReport(route.reportId), AbuseRepository.getTarget(route.targetId)]);
		if (!report || report.status === "canceled") continue;
		const snapshot = route.resolutionSnapshot ?? {};
		const kind = typeof snapshot.escalationKind === "string" ? snapshot.escalationKind : typeof snapshot.referralMailKind === "string" ? snapshot.referralMailKind : "mail";
		const context = report.campaignId
			? { href: `/operator/campaigns/${report.campaignId.toString()}`, label: "campaign" as const }
			: report.submissionId ? { href: `/submissions/${report.submissionId.toString()}`, label: "case" as const } : undefined;
		views.push({
			routeId: route.id.toString(),
			kind,
			recipient: route.verifiedEmail,
			recipientLabel: draft.recipientLabel,
			subject: draft.subject,
			body: draft.body,
			target: target?.normalizedTarget ?? "",
			createdAt: route.createdAt.toISOString(),
			...(typeof snapshot.escalationReason === "string" ? { reason: snapshot.escalationReason } : {}),
			...(context ? { context } : {}),
		});
	}
	return views;
}

async function requireDraftedMail(routeId: bigint): Promise<AbuseProviderRoute> {
	const route = await AbuseRepository.getRoute(routeId);
	if (!route || !approvalDraftOf(route)) throw new OperatorActionError("This is not a drafted mail.");
	if (route.status !== "awaiting_approval") throw new OperatorActionError(`This mail is ${route.status}, not waiting for approval.`);
	return route;
}

/**
 * The draft as it will be sent, checked by the same rules the sender applies
 * right before SMTP, so an approved mail is never refused at sending time.
 */
async function sendableDraft(route: AbuseProviderRoute, edited?: { subject: string; body: string }): Promise<ApprovalDraft> {
	const stored = approvalDraftOf(route)!;
	const draft: ApprovalDraft = edited
		? { subject: edited.subject.trim(), body: edited.body.replace(/\r\n/g, "\n").trim(), recipientLabel: stored.recipientLabel, allowedUrls: urlsIn(edited.body) }
		: stored;
	const input = await AbuseRepository.getReportInput(route.reportId);
	const target = input?.targets.find((candidate) => candidate.id === route.targetId);
	if (!input || !target) throw new OperatorActionError("The mail's report no longer exists.");
	const checked = readVerifiedEmailDraft(verifiedEmailProviderPayload({
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		recipient: route.verifiedEmail!,
		email: { subject: draft.subject, body: draft.body, recipientLabel: draft.recipientLabel },
	}), {
		recipient: route.verifiedEmail!,
		description: input.report.description,
		target: target.normalizedTarget,
		observedUrls: target.observedUrls,
		allowedUrls: [serviceIdentity.url, ...draft.allowedUrls],
	});
	if (!checked) throw new OperatorActionError("The mail cannot be sent as written: the subject must be at most 400 and the body at most 20,000 characters, without control characters, and every link must be a public http(s) URL.");
	return draft;
}

export async function saveDraftedMail(routeId: bigint, edited: { subject: string; body: string }): Promise<void> {
	const route = await requireDraftedMail(routeId);
	if (!await AbuseRepository.saveApprovalDraft(route.id, await sendableDraft(route, edited))) throw new OperatorActionError("The mail changed meanwhile; reload it.");
}

/** Approve a drafted mail, optionally as edited; it is sent exactly as approved. */
export async function approveDraftedMail(routeId: bigint, edited?: { subject: string; body: string }): Promise<void> {
	const route = await requireDraftedMail(routeId);
	if (!await AbuseRepository.approveDraftedRoute(route.id, await sendableDraft(route, edited))) throw new OperatorActionError("The mail changed meanwhile; reload it.");
}

export async function discardDraftedMail(routeId: bigint): Promise<void> {
	const route = await requireDraftedMail(routeId);
	if (!await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_approval", to: "discarded", data: { reason: "operator_discarded" } })) {
		throw new OperatorActionError("The mail changed meanwhile; reload it.");
	}
}

import { serviceIdentity } from "../constants";
import { abuseCaseTag } from "../abuse/mail/correlation";
import { readVerifiedEmailDraft, verifiedEmailProviderPayload } from "../abuse/mail/draft";
import { approvalDraftOf, type ApprovalDraft } from "../abuse/persistence/approvals";
import { hashStableJson } from "../abuse/security";
import { AbuseRepository } from "../abuse/repository";
import type { AbuseProviderRoute } from "../abuse/schema";
import { CampaignRepository } from "../campaign/repository";
import { authorityById, type Authority } from "./authorities";
import { dossierAttachments } from "./archive";
import { configuredComplainant, type Complainant } from "./complainant";
import { dossierDownloadUrl } from "./download_link";
import { buildReferralDossier, type Dossier, type DossierDependencies } from "./dossier";
import { complaintDraft, preservationNoticeDraft, supplementDraft, type ReferralDraft } from "./drafts";
import {
	authorityIdOf,
	authorityRegistryKey,
	isAuthorityRoute,
	isPreservationRoute,
	preservationRegistryKey,
	referralMailKind,
	reportedSubmissionIds,
	type ReferralMailKind,
} from "./routes";

export class ReferralError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReferralError";
	}
}

export type ReferralDependencies = {
	dossier?: DossierDependencies;
	complainant?: () => Complainant;
	now?: () => Date;
	env?: Record<string, string | undefined>;
};

/** Route statuses of a referral mail that reached, or is on its way to, its recipient. */
const SENT_STATUSES = new Set(["verified", "queued", "running", "submitted", "awaiting_provider_reply", "acknowledged", "provider_rejected", "delivery_failed", "unknown_external_state"]);
const LIVE_STATUSES = new Set([...SENT_STATUSES, "awaiting_approval"]);

const URL_IN_TEXT = /https?:\/\/[^\s<>'"`]+/gi;

export function urlsIn(text: string): string[] {
	return [...new Set((text.match(URL_IN_TEXT) ?? []).map((url) => url.replace(/[),.;!?]+$/, "")))];
}

/** The campaign's referral report and its one target, created on first use. */
async function ensureReferralReport(campaignId: bigint): Promise<{ reportId: bigint; targetId: bigint }> {
	const reportId = (await AbuseRepository.getCampaignReport(campaignId))?.id ?? await createReferralReport(campaignId);
	const [target] = await AbuseRepository.listTargets(reportId);
	if (!target) throw new ReferralError("The referral report has no target.");
	return { reportId, targetId: target.id };
}

async function createReferralReport(campaignId: bigint): Promise<bigint> {
	try {
		return (await AbuseRepository.createReport({
		campaignId,
		reporter: {},
		request: {
			originalRequest: { kind: "criminal_referral", campaignId: campaignId.toString() },
			targets: [{
				ordinal: 0,
				originalInput: `campaign:${campaignId.toString()}`,
				originalInputs: [`campaign:${campaignId.toString()}`],
				normalizedTarget: `campaign:${campaignId.toString()}`,
				targetType: "campaign",
				observedUrls: [],
			}],
			allegationCategory: "phishing",
			description: `Criminal referral of phishing campaign ${campaignId.toString()}.`,
			observedUrls: [],
			evidence: [],
			requestPayloadHash: hashStableJson({ kind: "criminal_referral", campaignId: campaignId.toString() }),
		},
	})).reportId;
	} catch (error) {
		// A concurrent first referral created it; the unique campaign index kept it to one.
		const created = await AbuseRepository.getCampaignReport(campaignId);
		if (created) return created.id;
		throw error;
	}
}

async function currentCampaign(campaignId: bigint): Promise<bigint> {
	const current = await CampaignRepository.currentCampaignId(campaignId);
	if (current === undefined) throw new ReferralError(`Campaign ${campaignId.toString()} does not exist.`);
	return current;
}

function requireAuthority(authorityId: string): Authority {
	const authority = authorityById(authorityId);
	if (!authority) throw new ReferralError(`Unknown authority ${authorityId}.`);
	return authority;
}

async function referralRoutes(reportId: bigint): Promise<AbuseProviderRoute[]> {
	return (await AbuseRepository.listRoutes(reportId)).filter((route) => isAuthorityRoute(route) || isPreservationRoute(route));
}

/**
 * Store one drafted referral mail as a route that waits for approval, with
 * its CSV attachments. Every mail is its own route, so each is approved,
 * sent and answered on its own.
 */
async function draftRoute(params: {
	reportId: bigint;
	targetId: bigint;
	routeKey: string;
	registryKey: string;
	recipient: string;
	recipientLabel: string;
	kind: ReferralMailKind;
	draft: ReferralDraft;
	submissionIds: string[];
	provenance: Record<string, unknown>;
	attachments: Array<{ name: string; mimeType: string; content: Buffer }>;
	extra?: Record<string, unknown>;
}): Promise<AbuseProviderRoute> {
	const approvalDraft: ApprovalDraft = { ...params.draft, recipientLabel: params.recipientLabel, allowedUrls: urlsIn(params.draft.body) };
	const route = await AbuseRepository.upsertResolvedRoute(params.targetId, {
		routeKey: params.routeKey,
		providerRegistryKey: params.registryKey,
		providerDisplayName: params.recipientLabel,
		routeType: "email",
		verifiedEmail: params.recipient,
		resolverProvenance: params.provenance,
		resolutionSnapshot: { referralMailKind: params.kind, submissionIds: params.submissionIds, approvalDraft, ...params.extra },
		status: "awaiting_approval",
	});
	for (const attachment of params.attachments) {
		await AbuseRepository.saveRouteArtifactOnce({
			reportId: params.reportId,
			routeId: route.id,
			targetId: params.targetId,
			name: attachment.name,
			kind: "referral_attachment",
			mimeType: attachment.mimeType,
			buffer: attachment.content,
		});
	}
	await AbuseRepository.recomputeReportStatus(params.reportId);
	return route;
}

function nextRouteKey(routes: readonly AbuseProviderRoute[], prefix: string): string {
	return `${prefix}:${routes.filter((route) => route.routeKey.startsWith(`${prefix}:`)).length + 1}`;
}

/** Draft the criminal complaint of a campaign to one authority. */
export async function prepareComplaint(campaignId: bigint, authorityId: string, dependencies: ReferralDependencies = {}): Promise<AbuseProviderRoute> {
	const authority = requireAuthority(authorityId);
	const complainant = (dependencies.complainant ?? configuredComplainant)();
	const current = await currentCampaign(campaignId);
	const dossier = await buildReferralDossier(current, dependencies.dossier);
	if (!dossier.sites.length) throw new ReferralError("The campaign has no sites.");
	const { reportId, targetId } = await ensureReferralReport(current);
	const routes = await referralRoutes(reportId);
	if (routes.some((route) => authorityIdOf(route) === authority.id && referralMailKind(route) === "complaint" && LIVE_STATUSES.has(route.status))) {
		throw new ReferralError(`A complaint to ${authority.name} is already drafted or sent; send new sites as a supplement.`);
	}
	const download = dossierDownloadUrl(current, (dependencies.now ?? (() => new Date()))(), dependencies.env);
	const draft = complaintDraft({ dossier, complainant, authority, caseTag: abuseCaseTag(reportId), download });
	return draftRoute({
		reportId,
		targetId,
		routeKey: nextRouteKey(routes, authorityRegistryKey(authority.id)),
		registryKey: authorityRegistryKey(authority.id),
		recipient: authority.email,
		recipientLabel: authority.name,
		kind: "complaint",
		draft,
		submissionIds: dossier.sites.map((site) => site.submissionId),
		provenance: { source: "authority_registry", authorityId: authority.id, authoritySource: authority.source },
		attachments: dossierAttachments(dossier),
	});
}

/** The authority's file number for this campaign, newest first. */
function caseReferenceFor(routes: readonly AbuseProviderRoute[], authorityId: string): string | undefined {
	return routes
		.filter((route) => authorityIdOf(route) === authorityId && route.caseReference)
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]?.caseReference ?? undefined;
}

/** Sites of the campaign no live mail to this authority has reported yet. */
export function unreportedSites(dossier: Dossier, routes: readonly AbuseProviderRoute[], authorityId: string) {
	const reported = new Set(routes
		.filter((route) => authorityIdOf(route) === authorityId && LIVE_STATUSES.has(route.status))
		.flatMap(reportedSubmissionIds));
	return dossier.sites.filter((site) => !reported.has(site.submissionId));
}

/** Draft a supplement with the sites the authority has not received yet. */
export async function prepareSupplement(campaignId: bigint, authorityId: string, dependencies: ReferralDependencies = {}): Promise<AbuseProviderRoute> {
	const authority = requireAuthority(authorityId);
	const complainant = (dependencies.complainant ?? configuredComplainant)();
	const current = await currentCampaign(campaignId);
	const { reportId, targetId } = await ensureReferralReport(current);
	const routes = await referralRoutes(reportId);
	const complaint = routes.find((route) => authorityIdOf(route) === authority.id && referralMailKind(route) === "complaint" && SENT_STATUSES.has(route.status));
	if (!complaint) throw new ReferralError(`No complaint to ${authority.name} was sent yet.`);
	if (routes.some((route) => authorityIdOf(route) === authority.id && route.status === "awaiting_approval")) {
		throw new ReferralError(`A mail to ${authority.name} still waits for approval; approve or discard it first.`);
	}
	const dossier = await buildReferralDossier(current, dependencies.dossier);
	const newSites = unreportedSites(dossier, routes, authority.id);
	if (!newSites.length) throw new ReferralError(`${authority.name} has received every site of this campaign.`);
	const download = dossierDownloadUrl(current, (dependencies.now ?? (() => new Date()))(), dependencies.env);
	const caseReference = caseReferenceFor(routes, authority.id);
	const draft = supplementDraft({
		dossier,
		complainant,
		authority,
		caseTag: abuseCaseTag(reportId),
		download,
		newSites,
		...(caseReference ? { caseReference } : {}),
		complaintSentAt: (typeof complaint.resolutionSnapshot.approvedAt === "string" ? complaint.resolutionSnapshot.approvedAt : complaint.updatedAt.toISOString()),
	});
	return draftRoute({
		reportId,
		targetId,
		routeKey: nextRouteKey(routes, authorityRegistryKey(authority.id)),
		registryKey: authorityRegistryKey(authority.id),
		recipient: authority.email,
		recipientLabel: authority.name,
		kind: "supplement",
		draft,
		submissionIds: newSites.map((site) => site.submissionId),
		provenance: { source: "authority_registry", authorityId: authority.id, authoritySource: authority.source },
		attachments: dossierAttachments(dossier),
	});
}

/**
 * Once an authority has given the case a file number, draft one preservation
 * notice per provider mailbox the campaign's sites were reported to. A
 * provider reached only through a web form has no mailbox to answer; its
 * lead is in the dossier for the authority instead.
 */
export async function preparePreservationNotices(campaignId: bigint, dependencies: ReferralDependencies = {}): Promise<AbuseProviderRoute[]> {
	const complainant = (dependencies.complainant ?? configuredComplainant)();
	const current = await currentCampaign(campaignId);
	const { reportId, targetId } = await ensureReferralReport(current);
	const routes = await referralRoutes(reportId);
	const withReference = routes
		.filter((route) => isAuthorityRoute(route) && route.caseReference)
		.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
	if (!withReference?.caseReference) throw new ReferralError("No authority has given this campaign a file number yet.");
	const authority = requireAuthority(authorityIdOf(withReference)!);
	const dossier = await buildReferralDossier(current, dependencies.dossier);
	const byRecipient = new Map<string, { label: string; sites: typeof dossier.sites }>();
	for (const site of dossier.sites) {
		for (const report of site.reports) {
			if (report.channel !== "email" || !report.contact || !report.reportedAt) continue;
			const recipient = report.contact.toLowerCase();
			const entry = byRecipient.get(recipient) ?? { label: report.provider, sites: [] };
			if (!entry.sites.includes(site)) entry.sites.push(site);
			byRecipient.set(recipient, entry);
		}
	}
	const drafted: AbuseProviderRoute[] = [];
	for (const [recipient, { label, sites }] of byRecipient) {
		const registryKey = preservationRegistryKey(recipient);
		if (routes.some((route) => route.providerRegistryKey === registryKey && LIVE_STATUSES.has(route.status))) continue;
		const draft = preservationNoticeDraft({ recipient, recipientLabel: label, authority, caseReference: withReference.caseReference, sites, complainant, caseTag: abuseCaseTag(reportId) });
		drafted.push(await draftRoute({
			reportId,
			targetId,
			routeKey: nextRouteKey(routes, registryKey),
			registryKey,
			recipient,
			recipientLabel: label,
			kind: "preservation_notice",
			draft,
			submissionIds: sites.map((site) => site.submissionId),
			provenance: { source: "campaign_takedown_reports", authorityId: authority.id, caseReference: withReference.caseReference },
			attachments: [],
		}));
	}
	if (!drafted.length) throw new ReferralError("Every provider mailbox of this campaign already has a preservation notice, or none was reported by mail.");
	return drafted;
}

function requireDraftedReferralRoute(route: AbuseProviderRoute | undefined): AbuseProviderRoute {
	if (!route || !(isAuthorityRoute(route) || isPreservationRoute(route))) throw new ReferralError("This is not a referral mail.");
	if (route.status !== "awaiting_approval") throw new ReferralError(`This mail is ${route.status}, not waiting for approval.`);
	return route;
}

/**
 * The draft as it will be sent, checked by the same rules the sender applies
 * right before SMTP, so an approved mail is never refused at sending time.
 */
async function sendableDraft(route: AbuseProviderRoute, edited?: { subject: string; body: string }): Promise<ApprovalDraft> {
	const stored = approvalDraftOf(route);
	if (!stored) throw new ReferralError("The mail has no draft.");
	const draft: ApprovalDraft = edited
		? { subject: edited.subject.trim(), body: edited.body.replace(/\r\n/g, "\n").trim(), recipientLabel: stored.recipientLabel, allowedUrls: urlsIn(edited.body) }
		: stored;
	const input = await AbuseRepository.getReportInput(route.reportId);
	const target = input?.targets.find((candidate) => candidate.id === route.targetId);
	if (!input || !target) throw new ReferralError("The referral report no longer exists.");
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
	if (!checked) throw new ReferralError("The mail cannot be sent as written: the subject must be at most 400 and the body at most 20,000 characters, without control characters, and every link must be a public http(s) URL.");
	return draft;
}

export async function saveReferralDraft(routeId: bigint, edited: { subject: string; body: string }): Promise<void> {
	const route = requireDraftedReferralRoute(await AbuseRepository.getRoute(routeId));
	if (!await AbuseRepository.saveApprovalDraft(route.id, await sendableDraft(route, edited))) throw new ReferralError("The mail changed meanwhile; reload it.");
}

/** Approve a drafted mail, optionally as edited; it is sent exactly as approved. */
export async function approveReferralMail(routeId: bigint, edited?: { subject: string; body: string }): Promise<void> {
	const route = requireDraftedReferralRoute(await AbuseRepository.getRoute(routeId));
	if (!await AbuseRepository.approveDraftedRoute(route.id, await sendableDraft(route, edited))) throw new ReferralError("The mail changed meanwhile; reload it.");
}

export async function discardReferralMail(routeId: bigint): Promise<void> {
	const route = requireDraftedReferralRoute(await AbuseRepository.getRoute(routeId));
	if (!await AbuseRepository.transitionRouteStatus({ routeId: route.id, from: "awaiting_approval", to: "discarded", data: { reason: "operator_discarded" } })) {
		throw new ReferralError("The mail changed meanwhile; reload it.");
	}
}

/** Set an authority's file number by hand, e.g. from a letter that came by post. */
export async function setReferralCaseReference(routeId: bigint, caseReference: string | null): Promise<void> {
	const route = await AbuseRepository.getRoute(routeId);
	if (!route || !isAuthorityRoute(route)) throw new ReferralError("Only a mail to an authority has a file number.");
	if (caseReference !== null && !/^[\p{L}\p{N} ./()-]{3,60}$/u.test(caseReference.trim())) throw new ReferralError("A file number has 3 to 60 letters, digits, spaces and . / ( ) -.");
	await AbuseRepository.setCaseReference(route.id, caseReference, "operator");
}

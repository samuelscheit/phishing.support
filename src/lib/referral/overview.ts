import { AbuseRepository } from "../abuse/repository";
import { approvalDraftOf } from "../abuse/persistence/approvals";
import { CampaignRepository } from "../campaign/repository";
import { AUTHORITIES, authorityById } from "./authorities";
import { buildDossier, type Dossier } from "./dossier";
import { describeIndicatorEnglish } from "./archive_text";
import { authorityIdOf, isAuthorityRoute, isPreservationRoute, referralMailKind, reportedSubmissionIds } from "./routes";
import { unreportedSites } from "./service";

export type ReferralMailView = {
	routeId: string;
	kind: string;
	recipient: string;
	recipientLabel: string;
	authorityId?: string;
	status: string;
	caseReference?: string;
	subject?: string;
	body?: string;
	siteCount: number;
	createdAt: string;
	updatedAt: string;
	approvedAt?: string;
	attachments: Array<{ id: string; name: string }>;
	messages: Array<{ id: string; direction: string; kind: string; status: string; from?: string; subject?: string; text?: string; classification?: string; occurredAt: string }>;
	/** File numbers the latest authority reply named when it named several; the operator chooses. */
	caseReferenceCandidates: string[];
};

export type CampaignOverview = {
	campaignId: string;
	/** The referral report, when one was opened; its attachments are served under it. */
	reportId?: string;
	mergedInto?: string;
	dossier: Dossier;
	indicators: Array<{ kind: string; value: string; links: boolean; siteCount: number; description: string }>;
	mails: ReferralMailView[];
	authorities: Array<{ id: string; name: string; email: string; scope: string; source: string; hasComplaint: boolean; hasDraftAwaitingApproval: boolean; unreportedSiteCount: number; caseReference?: string }>;
	canPreparePreservation: boolean;
};

/** Everything the campaign page shows, as plain JSON-safe values. */
export async function getCampaignOverview(campaignId: bigint): Promise<CampaignOverview | undefined> {
	const campaign = await CampaignRepository.getCampaign(campaignId);
	if (!campaign) return undefined;
	const dossier = await buildDossier(campaignId);
	const report = await AbuseRepository.getCampaignReport(campaignId);
	const routes = report ? (await AbuseRepository.listRoutes(report.id)).filter((route) => isAuthorityRoute(route) || isPreservationRoute(route)) : [];
	const messages = report ? await AbuseRepository.listMailForReport(report.id) : [];
	const events = report ? await AbuseRepository.listEvents(report.id) : [];
	const mails: ReferralMailView[] = [];
	for (const route of routes) {
		const draft = approvalDraftOf(route);
		const lastReply = events.filter((event) => event.routeId === route.id && event.eventType === "referral.reply_received").at(-1);
		const candidates = Array.isArray(lastReply?.data.caseReferenceCandidates) ? lastReply.data.caseReferenceCandidates.filter((value): value is string => typeof value === "string") : [];
		const attachments = await AbuseRepository.listRouteArtifacts(route.id, ["referral_attachment"]);
		mails.push({
			routeId: route.id.toString(),
			kind: referralMailKind(route) ?? "complaint",
			recipient: route.verifiedEmail ?? "",
			recipientLabel: route.providerDisplayName,
			...(authorityIdOf(route) ? { authorityId: authorityIdOf(route) } : {}),
			status: route.status,
			...(route.caseReference ? { caseReference: route.caseReference } : {}),
			...(draft ? { subject: draft.subject, body: draft.body } : {}),
			siteCount: reportedSubmissionIds(route).length,
			createdAt: route.createdAt.toISOString(),
			updatedAt: route.updatedAt.toISOString(),
			...(typeof route.resolutionSnapshot.approvedAt === "string" ? { approvedAt: route.resolutionSnapshot.approvedAt } : {}),
			attachments: attachments.map((artifact) => ({ id: artifact.id.toString(), name: artifact.name })),
			messages: messages.filter((message) => message.routeId === route.id).map((message) => ({
				id: message.id.toString(),
				direction: message.direction,
				kind: message.kind,
				status: message.status,
				...(message.fromAddress ? { from: message.fromAddress } : {}),
				...(message.subject ? { subject: message.subject } : {}),
				...(message.direction === "inbound" && message.textBody ? { text: message.textBody.slice(0, 20_000) } : {}),
				...(message.classification ? { classification: message.classification } : {}),
				occurredAt: message.occurredAt.toISOString(),
			})),
			caseReferenceCandidates: route.caseReference ? [] : candidates,
		});
	}
	const indicators = dossier.indicators.map((indicator) => ({
		kind: indicator.kind,
		value: indicator.value,
		links: indicator.links,
		siteCount: indicator.sites.length,
		description: describeIndicatorEnglish(indicator),
	}));
	const authorities = AUTHORITIES.map((authority) => {
		const own = routes.filter((route) => authorityIdOf(route) === authority.id);
		const caseReference = own.find((route) => route.caseReference)?.caseReference ?? undefined;
		return {
			id: authority.id,
			name: authority.name,
			email: authority.email,
			scope: authority.scope,
			source: authority.source,
			hasComplaint: own.some((route) => referralMailKind(route) === "complaint" && !["discarded"].includes(route.status)),
			hasDraftAwaitingApproval: own.some((route) => route.status === "awaiting_approval"),
			unreportedSiteCount: unreportedSites(dossier, routes, authority.id).length,
			...(caseReference ? { caseReference } : {}),
		};
	});
	return {
		campaignId: campaign.id.toString(),
		...(report ? { reportId: report.id.toString() } : {}),
		...(campaign.mergedInto ? { mergedInto: campaign.mergedInto.toString() } : {}),
		dossier,
		indicators,
		mails: mails.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
		authorities,
		canPreparePreservation: routes.some((route) => isAuthorityRoute(route) && Boolean(route.caseReference) && authorityById(authorityIdOf(route) ?? "")),
	};
}

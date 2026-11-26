import { AbuseRepository } from "../abuse/repository";
import type { AbuseReport } from "../abuse/schema";
import { comparePages, memberKey, screenshotPage, siteOf, sitePages, type CampaignSite } from "../campaign/members";
import { reportedSiteRoute, websiteRoutes } from "../website/routes";
import type { CapturePage } from "../website/visit/capture_files";
import { CampaignRepository, type CampaignMemberView } from "../campaign/repository";
import type { CampaignIndicator } from "../campaign/schema";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import type { Submission } from "../db/schema";
import type { WebsiteAccessStep } from "../website/types";
import { describeDataEntryField, type WebsiteRoute } from "../website/types";
import { isAuthorityRoute, isPreservationRoute } from "./routes";
import { indicatorInfrastructure, locateInfrastructure, mergeInfrastructure, routeInfrastructure, type InfrastructureClaim, type InfrastructureNode, type NetworkLookup } from "./infrastructure";
import { hostOf } from "../network/url";

/** One provider a site was reported to, and what became of the report. */
type DossierProviderReport = {
	provider: string;
	target: string;
	channel: "email" | "form" | "none";
	contact?: string;
	status: string;
	reportedAt?: string;
	confirmationId?: string;
};

type DossierEvidenceFile = { artifactId: string; name: string; kind: string; sha256: string; size: number; archivedAt?: string };

/** One mail to or from a provider about the site; the archive carries it as the original .eml. */
export type DossierMail = {
	reportId: string;
	direction: "inbound" | "outbound";
	occurredAt: string;
	provider: string;
	from?: string;
	to: string[];
	subject?: string;
	/** The stored original message, when there is one. */
	raw?: { artifactId: string; sha256: string; size: number };
	/** The message text, only when no original is stored. */
	text?: string;
};

/** Where the page sent the synthetic values our visit entered. */
type DossierDataDestination = { url: string; method: string; fields: string[]; sameSite: boolean };

/** Why the site was judged phishing or malware: the classifier's finding on the reported page. */
type DossierVerdict = {
	finding: string;
	basis?: string;
	/** The page's own words that show it, verbatim and in its language. */
	quote?: string;
	impersonates?: { name: string; officialUrl: string };
	/** The page's fields that collect the data, as the page labels them. */
	fields: string[];
	pageUrl?: string;
};

/** The visit through the site as the case recorded it at the time. */
/** The walk of a site: how it ended, what was done (by our agent, or a person who took over its browser) and the steps that reach the content. */
type DossierVisit = { outcome: string; failure?: string; actions: Array<{ kind: string; text: string; actor?: WebsiteAccessStep["actor"] }>; accessSteps: WebsiteAccessStep[] };

/** One member of the campaign: a site as one case confirmed it. */
export type DossierSite = {
	/** Unique within the dossier: one case can be a member for two sites, and two cases for one site. */
	key: string;
	submissionId: string;
	/** The site's primary report, the case's own or the one it joined. */
	reportId: string;
	/** The case's judged page of the site. */
	url: string;
	/** The captured judged page (`websiteCaptureFileNames`), when the case captured one. */
	page?: CapturePage;
	/** Every captured page of the site the case was shown, route by route in chain order. */
	pages: CapturePage[];
	host: string;
	firstSeenAt: string;
	registeredAt?: string;
	registrar?: string;
	/** The site's DNS answers when it was analyzed. */
	dns: { a: string[]; aaaa: string[]; cname: string[]; ns: string[] };
	dataDestinations: DossierDataDestination[];
	verdict?: DossierVerdict;
	visit?: DossierVisit;
	/** What we told the providers about the site. */
	reportText?: string;
	impersonates: string[];
	/** The site report's providers and those of the reports its investigation added (data drops, payload hosts). */
	reports: DossierProviderReport[];
	/** Every mail exchanged with providers about the site, oldest first; never the authorities'. */
	correspondence: DossierMail[];
	evidence: DossierEvidenceFile[];
	indicators: Array<Pick<CampaignIndicator, "kind" | "value" | "links" | "evidence">>;
};

/** One indicator with every site of the campaign that showed it. */
export type DossierIndicator = {
	kind: CampaignIndicator["kind"];
	value: string;
	links: boolean;
	evidence: Record<string, unknown>;
	sites: string[];
};

export type Dossier = {
	campaignId: string;
	generatedAt: string;
	firstSeenAt: string;
	lastSeenAt: string;
	sites: DossierSite[];
	indicators: DossierIndicator[];
	/** Every provider holding records about the operator, with its role and states. */
	infrastructure: InfrastructureNode[];
	impersonates: string[];
	/** What the sites asked visitors to enter, as the visits' synthetic values showed, in German. */
	dataRequested: string[];
	/** The same as field names (`email`, `password`, …). */
	requestedFields: string[];
};

export type DossierDependencies = {
	listMembers?: (campaignId: bigint) => Promise<CampaignMemberView[]>;
	loadSubmission?: (submissionId: bigint) => Promise<Submission | undefined>;
	listReports?: typeof AbuseRepository.listReportsForSubmission;
	listRoutes?: typeof AbuseRepository.listRoutes;
	listTargets?: typeof AbuseRepository.listTargets;
	listRuns?: typeof AbuseRepository.listProviderRunsForReport;
	listArtifacts?: typeof ArtifactsEntity.listForSubmission;
	listMail?: typeof AbuseRepository.listMailForReport;
	listReportArtifacts?: typeof AbuseRepository.listArtifactMetadata;
	/** Network lookups for buildReferralDossier; RIPEstat and DNS by default. */
	lookupNetwork?: NetworkLookup;
	now?: () => Date;
};

const EVIDENCE_KINDS = new Set(["website_mhtml", "website_png", "website_hop_body", "website_evidence"]);

const FIELD_LABELS: Readonly<Record<string, string>> = {
	email: "E-Mail-Adresse",
	password: "Passwort",
	phone: "Telefonnummer",
	cardNumber: "Kartennummer",
	oneTimeCode: "Einmalcode (TAN/OTP)",
};


function registrarName(submission: Submission | undefined): string | undefined {
	if (submission?.data.kind !== "website") return undefined;
	const registrar = submission.data.website.whois?.rdap?.registrar;
	const vcard = registrar?.vcard;
	const name = vcard?.fn ?? vcard?.org;
	return typeof name === "string" && name.trim() ? name.trim() : registrar?.handle;
}

function siteDns(submission: Submission | undefined): DossierSite["dns"] {
	const dns = submission?.data.kind === "website" ? submission.data.website.whois?.dns : undefined;
	return { a: dns?.A ?? [], aaaa: dns?.AAAA ?? [], cname: dns?.CNAME ?? [], ns: dns?.NS ?? [] };
}

/**
 * The route of the case that showed the member's site: the first route that
 * found it reportable, else the case's analyzed route. Its walk is the one
 * that sent the member's site the synthetic values.
 */
function memberRoute(submission: Submission | undefined, member: CampaignMemberView): WebsiteRoute | undefined {
	if (submission?.data.kind !== "website") return undefined;
	const website = submission.data.website;
	const reported = reportedSiteRoute(website, member.site);
	return websiteRoutes(website)[reported?.route ?? website.analyzedRoute ?? 0];
}

function dataDestinations(route: WebsiteRoute | undefined): DossierDataDestination[] {
	const unique = new Map<string, DossierDataDestination>();
	for (const request of route?.visit?.dataSent ?? []) {
		const key = `${request.method} ${request.url}`;
		const entry = unique.get(key) ?? { url: request.url, method: request.method, fields: [], sameSite: request.sameSite };
		entry.fields = [...new Set([...entry.fields, ...request.fields])];
		unique.set(key, entry);
	}
	return [...unique.values()];
}

/** The case's reportable assessment of the member's site: the page its report is about. A case without a recorded chain judged one site. */
function verdictOf(route: WebsiteRoute | undefined, member: CampaignMemberView): DossierVerdict | undefined {
	const hops = route?.hops ?? [];
	const assessment = route?.siteAssessments?.find((candidate) => (candidate.finding === "phishing" || candidate.finding === "malware")
		&& (!hops.length || siteOf(hops.find((hop) => hop.index === candidate.hopIndex)?.url) === member.site));
	if (!assessment) return undefined;
	const pageUrl = member.url;
	return {
		finding: assessment.finding,
		...(assessment.phishingBasis ? { basis: assessment.phishingBasis } : {}),
		...(assessment.evidenceQuote ? { quote: assessment.evidenceQuote } : {}),
		...(assessment.impersonatedBrand ? { impersonates: assessment.impersonatedBrand } : {}),
		fields: (assessment.collectionFields ?? []).map(describeDataEntryField),
		pageUrl,
	};
}

function visitOf(route: WebsiteRoute | undefined): DossierVisit | undefined {
	const visit = route?.visit;
	if (!visit) return undefined;
	return {
		outcome: visit.outcome,
		...(visit.failure ? { failure: visit.failure } : {}),
		actions: visit.actions.map(({ kind, text, actor }) => ({ kind, text, ...(actor ? { actor } : {}) })),
		// Visits recorded before the steps were kept have none.
		accessSteps: visit.accessSteps ?? [],
	};
}

function registeredAt(submission: Submission | undefined): string | undefined {
	if (submission?.data.kind !== "website") return undefined;
	return submission.data.website.whois?.rdap?.events?.registration;
}

/** The site report a derived report came from, as its stored request names it. */
async function derivedFrom(report: AbuseReport): Promise<string | undefined> {
	const [request] = await AbuseRepository.listArtifacts(report.id, ["original_request"]);
	if (!request) return undefined;
	try {
		const source = (JSON.parse(Buffer.from(request.blob).toString("utf8")) as { sourceReportId?: unknown }).sourceReportId;
		return typeof source === "string" ? source : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The reports about a member's site: its site report, and the reports the
 * case's investigation of that report added (`sourceReportId`). A derived
 * report that names no source goes with the case's first own site report,
 * whose investigation reports the visit's data drops.
 */
async function memberReports(member: CampaignSite, listReports: NonNullable<DossierDependencies["listReports"]>): Promise<AbuseReport[]> {
	const own = await listReports(member.submissionId);
	const site = own.find((report) => report.id === member.reportId) ?? await AbuseRepository.getReport(member.reportId);
	const first = own.find((report) => !report.idempotencyKey)?.id.toString();
	const derived: AbuseReport[] = [];
	for (const report of own) {
		if (!report.idempotencyKey) continue;
		if (((await derivedFrom(report)) ?? first) === member.reportId.toString()) derived.push(report);
	}
	return [...(site ? [site] : []), ...derived];
}

/**
 * Everything an authority needs about one campaign, read from what the case
 * records hold: each site with its takedown reports and evidence files, the
 * indicators that link the sites, and for each provider how an investigator
 * reaches its records. Nothing in it is generated; every value is stored data.
 */
export async function buildDossier(campaignId: bigint, dependencies: DossierDependencies = {}): Promise<Dossier> {
	const listMembers = dependencies.listMembers ?? ((id: bigint) => CampaignRepository.listMembers(id));
	const loadSubmission = dependencies.loadSubmission ?? SubmissionsEntity.get;
	const listReports = dependencies.listReports ?? AbuseRepository.listReportsForSubmission;
	const listRoutes = dependencies.listRoutes ?? AbuseRepository.listRoutes;
	const listTargets = dependencies.listTargets ?? AbuseRepository.listTargets;
	const listRuns = dependencies.listRuns ?? AbuseRepository.listProviderRunsForReport;
	const listArtifacts = dependencies.listArtifacts ?? ArtifactsEntity.listForSubmission;
	const listMail = dependencies.listMail ?? AbuseRepository.listMailForReport;
	const listReportArtifacts = dependencies.listReportArtifacts ?? AbuseRepository.listArtifactMetadata;
	const members = await listMembers(campaignId);

	const sites: DossierSite[] = [];
	const claims: Array<{ site: string; claim: InfrastructureClaim }> = [];
	for (const member of members) {
		const submission = await loadSubmission(member.submissionId);
		const reports: DossierProviderReport[] = [];
		const correspondence: DossierMail[] = [];
		const impersonates = new Set<string>();
		let reportText: string | undefined;
		for (const report of await memberReports(member, listReports)) {
			if (report.legalBrandUrl) impersonates.add(hostOf(report.legalBrandUrl));
			if (report.id === member.reportId && report.description) reportText = report.description;
			const [routes, targets, runs, mails, artifacts] = await Promise.all([listRoutes(report.id), listTargets(report.id), listRuns(report.id), listMail(report.id), listReportArtifacts(report.id)]);
			const providerRoutes = new Map(routes.filter((route) => !isAuthorityRoute(route)).map((route) => [route.id, route]));
			for (const mail of mails) {
				const route = providerRoutes.get(mail.routeId);
				if (!route) continue;
				const raw = mail.rawArtifactId === null ? undefined : artifacts.find((artifact) => artifact.id === mail.rawArtifactId);
				correspondence.push({
					reportId: report.id.toString(),
					direction: mail.direction,
					occurredAt: mail.occurredAt.toISOString(),
					provider: route.providerDisplayName,
					...(mail.fromAddress ? { from: mail.fromAddress } : {}),
					to: mail.toAddresses,
					...(mail.subject ? { subject: mail.subject } : {}),
					...(raw ? { raw: { artifactId: raw.id.toString(), sha256: raw.sha256, size: raw.size } } : mail.textBody ? { text: mail.textBody } : {}),
				});
			}
			for (const route of routes) {
				if (isAuthorityRoute(route) || isPreservationRoute(route)) continue;
				const claim = routeInfrastructure(route);
				if (claim) claims.push({ site: member.url, claim });
				const run = runs.filter((candidate) => candidate.routeId === route.id).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
				reports.push({
					provider: route.providerDisplayName,
					target: targets.find((target) => target.id === route.targetId)?.normalizedTarget ?? "",
					channel: route.routeType === "email" ? "email" : route.routeType === "provider_submission" ? "form" : "none",
					...(route.verifiedEmail ? { contact: route.verifiedEmail } : {}),
					status: route.status,
					...(run ? { reportedAt: run.createdAt.toISOString() } : {}),
					...(run?.confirmationId ? { confirmationId: run.confirmationId } : {}),
				});
			}
		}
		const evidence = (await listArtifacts(member.submissionId))
			.filter((artifact) => EVIDENCE_KINDS.has(artifact.kind) && artifact.sha256)
			.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
			.map((artifact) => ({
				artifactId: artifact.id.toString(),
				name: artifact.name ?? `artifact-${artifact.id.toString()}`,
				kind: artifact.kind,
				sha256: artifact.sha256!,
				size: artifact.size ?? 0,
				...(artifact.archivedAt ? { archivedAt: artifact.archivedAt.toISOString() } : {}),
			}));
		const route = memberRoute(submission, member);
		const verdict = verdictOf(route, member);
		const visit = visitOf(route);
		const registered = registeredAt(submission);
		const registrar = registrarName(submission);
		// A case without a recorded chain showed its one site every page it captured.
		const shown = (submission?.data.kind === "website" ? sitePages(submission.data.website, member.site) : [])
			?? evidence.flatMap((file) => screenshotPage(file.name) ?? []);
		const pages = [...shown, ...(member.page ? [member.page] : [])]
			.filter((page, index, all) => all.findIndex((other) => comparePages(other, page) === 0) === index)
			.sort(comparePages);
		sites.push({
			key: memberKey(member),
			submissionId: member.submissionId.toString(),
			reportId: member.reportId.toString(),
			url: member.url,
			...(member.page ? { page: member.page } : {}),
			pages,
			host: hostOf(member.url),
			firstSeenAt: member.createdAt.toISOString(),
			...(registered ? { registeredAt: registered } : {}),
			...(registrar ? { registrar } : {}),
			dns: siteDns(submission),
			dataDestinations: dataDestinations(route),
			...(verdict ? { verdict } : {}),
			...(visit ? { visit } : {}),
			...(reportText ? { reportText } : {}),
			impersonates: [...new Set([...impersonates, ...(verdict?.impersonates ? [verdict.impersonates.name] : [])])].sort(),
			reports,
			correspondence: correspondence.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)),
			evidence,
			indicators: member.indicators.map(({ kind, value, links, evidence: indicatorEvidence }) => ({ kind, value, links, evidence: indicatorEvidence })),
		});
	}

	const indicatorMap = new Map<string, DossierIndicator>();
	for (const site of sites) {
		for (const indicator of site.indicators) {
			const key = `${indicator.kind}:${indicator.value}`;
			const entry = indicatorMap.get(key) ?? { kind: indicator.kind, value: indicator.value, links: indicator.links, evidence: indicator.evidence, sites: [] };
			if (!entry.sites.includes(site.url)) entry.sites.push(site.url);
			indicatorMap.set(key, entry);
		}
	}
	const kindOrder = ["operator_server", "payment_receiver", "delivery_command", "kit_fingerprint", "origin_ip"];
	const indicators = [...indicatorMap.values()].sort((a, b) =>
		kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || b.sites.length - a.sites.length || a.value.localeCompare(b.value));

	for (const indicator of indicators) {
		const claim = indicatorInfrastructure(indicator);
		if (claim) for (const site of indicator.sites) claims.push({ site, claim });
	}
	const infrastructure = mergeInfrastructure(claims);

	const dataRequested = new Set<string>();
	const requestedFields = [
		...indicators.flatMap((indicator) => Array.isArray(indicator.evidence.matchedFields) ? indicator.evidence.matchedFields : []),
		...sites.flatMap((site) => site.dataDestinations.flatMap((destination) => destination.fields)),
	];
	const fieldNames = [...new Set(requestedFields.filter((field): field is string => typeof field === "string" && Boolean(FIELD_LABELS[field])))];
	for (const field of fieldNames) dataRequested.add(FIELD_LABELS[field]!);
	const seen = sites.map((site) => site.firstSeenAt).sort();
	const now = (dependencies.now ?? (() => new Date()))();
	return {
		campaignId: campaignId.toString(),
		generatedAt: now.toISOString(),
		firstSeenAt: seen[0] ?? now.toISOString(),
		lastSeenAt: seen.at(-1) ?? now.toISOString(),
		sites,
		indicators,
		infrastructure,
		impersonates: [...new Set(sites.flatMap((site) => site.impersonates))].sort(),
		dataRequested: [...dataRequested],
		requestedFields: fieldNames,
	};
}

/**
 * The dossier an authority receives: as buildDossier, with every state of the
 * infrastructure looked up. Views that show no infrastructure use buildDossier.
 */
export async function buildReferralDossier(campaignId: bigint, dependencies: DossierDependencies = {}): Promise<Dossier> {
	const dossier = await buildDossier(campaignId, dependencies);
	return { ...dossier, infrastructure: await locateInfrastructure(dossier.infrastructure, dependencies.lookupNetwork) };
}

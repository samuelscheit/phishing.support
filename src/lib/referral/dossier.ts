import { AbuseRepository } from "../abuse/repository";
import { CampaignRepository, type CampaignMemberView } from "../campaign/repository";
import type { CampaignIndicator } from "../campaign/schema";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import type { Submission } from "../db/schema";
import { describeDataEntryField } from "../website/types";
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
type DossierVisit = { outcome: string; failure?: string; actions: Array<{ kind: string; text: string }> };

export type DossierSite = {
	submissionId: string;
	url: string;
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

const EVIDENCE_KINDS = new Set(["website_mhtml", "website_png", "website_evidence"]);

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

function dataDestinations(submission: Submission | undefined): DossierDataDestination[] {
	const sent = submission?.data.kind === "website" ? submission.data.website.visit?.dataSent ?? [] : [];
	const unique = new Map<string, DossierDataDestination>();
	for (const request of sent) {
		const key = `${request.method} ${request.url}`;
		const entry = unique.get(key) ?? { url: request.url, method: request.method, fields: [], sameSite: request.sameSite };
		entry.fields = [...new Set([...entry.fields, ...request.fields])];
		unique.set(key, entry);
	}
	return [...unique.values()];
}

/** The reportable assessment of the case: the page its report is about. */
function verdictOf(submission: Submission | undefined): DossierVerdict | undefined {
	if (submission?.data.kind !== "website") return undefined;
	const website = submission.data.website;
	const assessment = website.siteAssessments?.find((candidate) => candidate.finding === "phishing" || candidate.finding === "malware");
	if (!assessment) return undefined;
	const pageUrl = website.navigationHops?.find((hop) => hop.index === assessment.hopIndex)?.url ?? website.archiveUrl ?? website.url;
	return {
		finding: assessment.finding,
		...(assessment.phishingBasis ? { basis: assessment.phishingBasis } : {}),
		...(assessment.evidenceQuote ? { quote: assessment.evidenceQuote } : {}),
		...(assessment.impersonatedBrand ? { impersonates: assessment.impersonatedBrand } : {}),
		fields: (assessment.collectionFields ?? []).map(describeDataEntryField),
		pageUrl,
	};
}

function visitOf(submission: Submission | undefined): DossierVisit | undefined {
	const visit = submission?.data.kind === "website" ? submission.data.website.visit : undefined;
	if (!visit) return undefined;
	return { outcome: visit.outcome, ...(visit.failure ? { failure: visit.failure } : {}), actions: visit.actions.map(({ kind, text }) => ({ kind, text })) };
}

function registeredAt(submission: Submission | undefined): string | undefined {
	if (submission?.data.kind !== "website") return undefined;
	return submission.data.website.whois?.rdap?.events?.registration;
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
		for (const report of await listReports(member.submissionId)) {
			if (report.legalBrandUrl) impersonates.add(hostOf(report.legalBrandUrl));
			if (!report.idempotencyKey && report.description) reportText = report.description;
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
		const verdict = verdictOf(submission);
		const visit = visitOf(submission);
		const registered = registeredAt(submission);
		const registrar = registrarName(submission);
		sites.push({
			submissionId: member.submissionId.toString(),
			url: member.url,
			host: hostOf(member.url),
			firstSeenAt: member.createdAt.toISOString(),
			...(registered ? { registeredAt: registered } : {}),
			...(registrar ? { registrar } : {}),
			dns: siteDns(submission),
			dataDestinations: dataDestinations(submission),
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

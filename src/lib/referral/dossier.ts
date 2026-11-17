import { AbuseRepository } from "../abuse/repository";
import { CampaignRepository, type CampaignMemberView } from "../campaign/repository";
import type { CampaignIndicator } from "../campaign/schema";
import { ArtifactsEntity, SubmissionsEntity } from "../db/entities";
import type { Submission } from "../db/schema";
import { describeDataEntryField } from "../website_types";
import { isAuthorityRoute, isPreservationRoute } from "./routes";
import { GENERIC_LEAD, providerLead, type ProviderLead } from "./provider_leads";

/** One provider a site was reported to, and what became of the report. */
export type DossierProviderReport = {
	provider: string;
	target: string;
	channel: "email" | "form" | "none";
	contact?: string;
	status: string;
	reportedAt?: string;
	confirmationId?: string;
};

export type DossierEvidenceFile = { artifactId: string; name: string; kind: string; sha256: string; size: number; archivedAt?: string };

/** Where the page sent the synthetic values our visit entered. */
export type DossierDataDestination = { url: string; method: string; fields: string[]; sameSite: boolean };

/** Why the site was judged phishing or malware: the classifier's finding on the reported page. */
export type DossierVerdict = {
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
export type DossierVisit = { outcome: string; failure?: string; actions: Array<{ kind: string; text: string }> };

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

export type DossierProvider = {
	name: string;
	siteCount: number;
	contacts: string[];
	lead?: ProviderLead;
};

export type Dossier = {
	campaignId: string;
	generatedAt: string;
	firstSeenAt: string;
	lastSeenAt: string;
	sites: DossierSite[];
	indicators: DossierIndicator[];
	providers: DossierProvider[];
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

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

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
	const members = await listMembers(campaignId);

	const sites: DossierSite[] = [];
	for (const member of members) {
		const submission = await loadSubmission(member.submissionId);
		const reports: DossierProviderReport[] = [];
		const impersonates = new Set<string>();
		let reportText: string | undefined;
		for (const report of await listReports(member.submissionId)) {
			if (report.legalBrandUrl) impersonates.add(hostOf(report.legalBrandUrl));
			if (!report.idempotencyKey && report.description) reportText = report.description;
			const [routes, targets, runs] = await Promise.all([listRoutes(report.id), listTargets(report.id), listRuns(report.id)]);
			for (const route of routes) {
				if (isAuthorityRoute(route) || isPreservationRoute(route)) continue;
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
	const kindOrder = ["exfiltration_backend", "payment_receiver", "kit_fingerprint", "origin_ip"];
	const indicators = [...indicatorMap.values()].sort((a, b) =>
		kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || b.sites.length - a.sites.length || a.value.localeCompare(b.value));

	const providerMap = new Map<string, { sites: Set<string>; contacts: Set<string> }>();
	const addProvider = (name: string, site: string, contact?: string) => {
		const entry = providerMap.get(name) ?? { sites: new Set<string>(), contacts: new Set<string>() };
		entry.sites.add(site);
		if (contact) entry.contacts.add(contact);
		providerMap.set(name, entry);
	};
	for (const site of sites) for (const report of site.reports) addProvider(report.provider, site.url, report.contact);
	for (const indicator of indicators) {
		if (indicator.kind !== "exfiltration_backend") continue;
		const backendKind = indicator.evidence.backendKind;
		if (backendKind === "telegram_bot") for (const site of indicator.sites) addProvider("Telegram", site);
		if (backendKind === "discord_webhook") for (const site of indicator.sites) addProvider("Discord", site);
	}
	const providers = [...providerMap].map(([name, entry]) => {
		const lead = providerLead(name);
		return { name, siteCount: entry.sites.size, contacts: [...entry.contacts].sort(), ...(lead ? { lead } : {}) };
	}).sort((a, b) => b.siteCount - a.siteCount || a.name.localeCompare(b.name));

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
		providers,
		impersonates: [...new Set(sites.flatMap((site) => site.impersonates))].sort(),
		dataRequested: [...dataRequested],
		requestedFields: fieldNames,
	};
}

export { GENERIC_LEAD };

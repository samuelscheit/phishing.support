import { publicCampaignUrl } from "../campaign/urls";
import { describeIndicatorEnglish, fieldLabel } from "./archive_text";
import { countryName, countryRoutes, directComplaint, isEuMemberState } from "./countries";
import type { Dossier } from "./dossier";
import { plural, utc } from "./format";
import { claimNodeName, indicatorInfrastructure, nodeHolder, ROLE_LABEL, type InfrastructureNode } from "./infrastructure";
import { OFFENCES, OFFENCES_TRANSLATION_SOURCE } from "./offences";

/**
 * One English annex per state the campaign's infrastructure lies in: what
 * lies there, the identifiers a provider needs to find its customer, the
 * routes from Germany, pre-filled preservation and production requests,
 * and the German offences in their wording. It serves the German authority
 * asking that state for help, and an authority there directly.
 */
export type CountryAnnex = { country: string; fileName: string; text: string };

const OFFENCE_LIST = OFFENCES.map((offence) => `section ${offence.section}`).join(", ");

/** The state's English name as it reads inside a sentence: "the United Kingdom", "the Netherlands". */
function inSentence(code: string): string {
	const name = countryName(code).en;
	return /^(?:United |Netherlands|Philippines|Bahamas|Gambia|Czech Republic|Dominican Republic|Maldives|Marshall Islands|Seychelles)/.test(name) ? `the ${name}` : name;
}

function slug(value: string): string {
	return value.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

/** Everything a provider needs to find the customer behind the node. */
function nodeIdentifiers(node: InfrastructureNode, dossier: Dossier): string[] {
	const firstSeen = new Map(dossier.sites.map((site) => [site.url, site.firstSeenAt]));
	const urls = node.role === "payment" ? [] : node.sites.map((url) => `${url} (first seen ${utc(firstSeen.get(url) ?? "")})`);
	const indicators = dossier.indicators
		.filter((indicator) => {
			const claim = indicatorInfrastructure(indicator);
			return claim?.role === node.role && claimNodeName(claim) === node.name;
		})
		.map(describeIndicatorEnglish);
	return [...urls, ...node.resources.map((resource) => `${resource.startsWith("AS") ? "network" : "address"} ${resource}`), ...indicators];
}

function period(node: InfrastructureNode, dossier: Dossier): { first: string; last: string } {
	const seen = dossier.sites.filter((site) => node.sites.includes(site.url)).map((site) => site.firstSeenAt).sort();
	return { first: seen[0] ?? dossier.firstSeenAt, last: seen.at(-1) ?? dossier.lastSeenAt };
}

function campaignFacts(dossier: Dossier): string {
	const imitates = dossier.impersonates.length ? ` imitated ${dossier.impersonates.join(", ")} and` : "";
	const fields = dossier.requestedFields.length ? ` asked visitors for ${dossier.requestedFields.map(fieldLabel).join(", ")}` : " asked visitors for their data";
	return `${plural(dossier.sites.length, "phishing website", "phishing websites")}, first seen between ${utc(dossier.firstSeenAt)} and ${utc(dossier.lastSeenAt)},${imitates}${fields}, which the operators collected.`;
}

function nodeSection(node: InfrastructureNode, dossier: Dossier, country: string): string[] {
	const { first, last } = period(node, dossier);
	const holder = nodeHolder(node, "en");
	// The server's host holds the server; behind a CDN without a named origin, the CDN holds what leads there.
	const custodian = node.originHost ?? node.lead?.holder.en ?? node.via ?? node.name;
	const records = node.role === "payment"
		? `The account holder's identity, the account's opening documents and its transactions, from ${utc(first)} to the present.`
		: `The customer account behind these identifiers: subscriber and payment data, and the IP addresses and times of account creation and of every login, upload or configuration change, from account creation to the present; at least for ${utc(first)} to ${utc(last)}.`;
	const lines = [
		`${ROLE_LABEL[node.role].en}: ${holder}`,
		...node.lead && !node.via ? [`  ${node.lead.facts.en}`] : [],
		...node.serverCountry && node.serverCountry !== country ? [`  Server located in ${inSentence(node.serverCountry)}.`] : [],
		...node.contacts.length ? [`  Abuse contact: ${node.contacts.join(", ")}`] : [],
		"  Identifiers:",
		...nodeIdentifiers(node, dossier).map((identifier) => `    - ${identifier}`),
		`  Records that identify the operator: ${records}`,
		"",
		"  Preservation request (Budapest Convention, Art. 29 (2)), pre-filled:",
		"    a. Requesting authority: [to be completed by the authority]",
		`    b. Offence and summary of facts: ${campaignFacts(dossier)} Offences under ${OFFENCE_LIST} of the German Criminal Code (wording below).`,
		`    c. Stored data to be preserved and its relation to the offence: ${records} The account operated the identifiers above, which served the campaign.`,
		`    d. Custodian and location: ${custodian}, ${inSentence(country)}.`,
		`    e. Necessity: providers delete account and log data after a takedown or the end of a contract${node.lead && !node.via ? "; see the provider's own terms above" : ""}.`,
		"    f. A request for mutual legal assistance will follow: [to be confirmed by the authority]",
	];
	if (isEuMemberState(country) && country !== "DK") {
		lines.push(
			"",
			"  European Production Order (Regulation (EU) 2023/1543), pre-filled:",
			`    Addressee: the designated establishment or legal representative in the EU of ${custodian}.`,
			"    Data: subscriber data, and data requested only to identify the user (the IP addresses and times of account creation and logins). A public prosecutor may order these; traffic and content data need a judge.",
			"    Identifiers and period: as above.",
		);
	}
	return lines;
}

function offenceSection(): string[] {
	return [
		"German offences (Strafgesetzbuch, StGB)",
		`The German text is authoritative; the English translation is the Federal Ministry of Justice's (${OFFENCES_TRANSLATION_SOURCE}) and not binding.`,
		...OFFENCES.flatMap((offence) => [
			"",
			`Section ${offence.section} StGB – ${offence.titleEn} (${offence.titleDe}), ${offence.sourceDe}`,
			offence.textDe,
			"",
			offence.textEn,
		]),
	];
}

export function countryAnnexes(dossier: Dossier): CountryAnnex[] {
	const byCountry = new Map<string, InfrastructureNode[]>();
	for (const node of dossier.infrastructure) {
		if (!node.country || node.country === "DE") continue;
		byCountry.set(node.country, [...byCountry.get(node.country) ?? [], node]);
	}
	return [...byCountry].map(([country, nodes]) => {
		const name = countryName(country).en;
		const within = inSentence(country);
		const complaint = directComplaint(country);
		const linking = dossier.indicators.filter((indicator) => indicator.links);
		const text = [
			`Annex for ${name} (${country}): phishing campaign ${dossier.campaignId} (phishing.support)`,
			`Generated ${utc(dossier.generatedAt)}. Public page: ${publicCampaignUrl(dossier.campaignId)}`,
			"",
			`This annex collects the part of the campaign that lies in ${within}, for an authority there or for the German authority asking it for help. phishing.support is a private, non-commercial reporter in Germany; this annex is not a request by an authority. Every fact is taken from the evidence in this archive (dossier.txt, sites.csv, indicators.csv, evidence/).`,
			"",
			"The campaign",
			`  ${campaignFacts(dossier)}`,
			...linking.length ? ["  What ties the sites to one operator:", ...linking.map((indicator) => `    - ${describeIndicatorEnglish(indicator)}`)] : [],
			"",
			`Routes from Germany to ${within}`,
			...countryRoutes(country).map((route) => `  - ${route.en}`),
			...complaint ? [`  - A complaint by phishing.support itself is possible: ${complaint.en}`] : [],
			"",
			`Providers in ${within}`,
			...nodes.flatMap((node) => ["", ...nodeSection(node, dossier, country).map((line) => (line ? `  ${line}` : line))]),
			"",
			...offenceSection(),
		].join("\n");
		return { country, fileName: `annexes/${country}-${slug(name)}.txt`, text: `${text}\n` };
	});
}

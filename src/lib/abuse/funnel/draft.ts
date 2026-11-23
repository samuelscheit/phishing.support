import { serviceIdentity } from "../../network/service_identity";
import { abuseCaseTag } from "../mail/correlation";
import type { AbuseMailAttachment } from "../mail/types";
import { routeContact } from "../resolver/contact_chain";
import type { AbuseProviderRoute, AbuseReport, AbuseTarget } from "../schema";
import { parsedUrl } from "./chain";
import { DECEPTION_KINDS, DECEPTION_PHRASES, type DeceptionKind } from "./deception";
import { FUNNEL_EVIDENCE_NAME, readFunnelFacts, type FunnelFacts } from "./facts";
import { PLATFORM_NAMES, type FunnelPlatform } from "./platforms";
import { parseFunnelPartyTarget } from "./target";

/** Same shape as mail/draft.ts's AbuseEmailDraft. */
type FunnelEmailDraft = { subject: string; body: string; recipientLabel: string };

export type FunnelDraftInput = {
	report: Pick<AbuseReport, "id" | "submissionId">;
	target: Pick<AbuseTarget, "normalizedTarget" | "observedUrls">;
	route: Pick<AbuseProviderRoute, "providerDisplayName" | "resolverProvenance" | "resolutionSnapshot">;
	/** The files the mail carries; the facts file among them is what the mail is drafted from. */
	evidence?: readonly AbuseMailAttachment[];
	attachmentNames?: string[];
};

const MAX_CHAIN_LINES = 40;
const MAX_BODY_LENGTH = 20_000;

function platformName(platform: string | undefined): string | undefined {
	return platform && Object.hasOwn(PLATFORM_NAMES, platform) ? PLATFORM_NAMES[platform as FunnelPlatform] : undefined;
}

function identifierText({ kind, parameter, value }: { kind: string; parameter: string; value: string }): string {
	return parameter === "path" ? `${kind} ${value} (in the link path)` : `${parameter}=${value}`;
}

/** A URL as the mail may print it: only URLs the report recorded, others by host. */
function urlText(value: string, allowed: ReadonlySet<string>): string {
	if (allowed.has(value)) return value;
	const host = parsedUrl(value)?.hostname;
	return host ? `${host} (full URL in ${FUNNEL_EVIDENCE_NAME})` : `(URL in ${FUNNEL_EVIDENCE_NAME})`;
}

function contactSentence(route: FunnelDraftInput["route"], facts: FunnelFacts, vendorName: string | undefined): string {
	const contact = routeContact(route.resolverProvenance);
	const foundAt = typeof contact.foundAt === "string" ? parsedUrl(contact.foundAt)?.hostname : undefined;
	const platform = platformName(facts.party.platform) ?? "tracking";
	switch (contact.source) {
		case "platform_vendor":
			return `The operator of ${facts.party.site} publishes no contact, so we are writing to ${vendorName ?? "you"} as the provider of its ${platform} platform: please act on this under your terms of service, or forward this report to your customer who runs ${facts.party.site}.`;
		case "security_txt":
			return `We are writing to the contact the security.txt of ${foundAt ?? facts.party.site} names.`;
		case "website":
			return `We are writing to the contact ${foundAt ?? facts.party.site} publishes.`;
		case "holder_rdap":
		case "holder_whois":
			return `We are writing to the contact in the domain registration of ${facts.party.site}.`;
		default:
			return `We are writing to the contact we found for ${facts.party.site}.`;
	}
}

/** Every affiliate ID of the chain, the recipient's own first: each business can trace the others' through its partners. */
function affiliateLines(facts: FunnelFacts): string[] {
	const own = facts.affiliates.filter((affiliate) => affiliate.site === facts.party.site);
	return [...own, ...facts.affiliates.filter((affiliate) => !own.includes(affiliate))].map((affiliate) => {
		const platform = platformName(affiliate.platform);
		const matched = affiliate.matchedAt.length ? `; the same ID is the affiliate on ${affiliate.matchedAt.join(", ")}` : "";
		const likely = affiliate.confidence === "high" ? "" : ` (${affiliate.confidence === "medium" ? "likely" : "possibly"} the affiliate ID)`;
		return `- ${affiliate.id}: ${identifierText({ kind: "affiliate", parameter: affiliate.parameter, value: affiliate.id })} on ${affiliate.site}${platform ? ` (${platform})` : ""}${likely}${matched}`;
	});
}

/** One line per tracking host, with every value its links carried. */
function trackerLines(facts: FunnelFacts): string[] {
	const hosts = [...new Set(facts.trackers.map((tracker) => tracker.hostname))];
	return hosts.map((hostname) => {
		const trackers = facts.trackers.filter((tracker) => tracker.hostname === hostname);
		const first = trackers[0]!;
		const values = [...new Set(trackers.flatMap((tracker) => tracker.identifiers.map(identifierText)))].join(", ");
		const runner = first.role === "network" ? "affiliate network or program" : "the affiliate's own tracker";
		const carried = trackers.every((tracker) => tracker.carriedBy) ? `, a link carried in the ${first.carriedBy!.parameter} of hop ${first.hopIndex + 1}` : "";
		return `- ${hostname}: ${platformName(first.platform)} (${runner}${carried})${values ? `: ${values}` : ""}`;
	});
}

const KIND_LABEL: Readonly<Record<FunnelFacts["chain"][number]["kind"], string>> = {
	tracker: "tracking link",
	redirector: "redirect wrapper",
	lure: "lure page shown",
	merchant: "merchant page",
	redirect: "redirect",
};

function chainLines(facts: FunnelFacts, allowed: ReadonlySet<string>): string[] {
	const trackers = new Map(facts.trackers.filter((tracker) => !tracker.carriedBy).map((tracker) => [tracker.hopIndex, tracker]));
	const lines = facts.chain.slice(0, MAX_CHAIN_LINES).map((hop) => {
		const tracker = trackers.get(hop.index);
		const label = tracker ? `${platformName(tracker.platform)} ${KIND_LABEL.tracker}` : KIND_LABEL[hop.kind];
		return `${hop.index + 1}. ${hop.at ?? "time not recorded"}  HTTP ${hop.status ?? "-"}  ${urlText(hop.url, allowed)}  [${label}]`;
	});
	const more = facts.chain.length - MAX_CHAIN_LINES;
	return more > 0 ? [...lines, `(${more} more hops in ${FUNNEL_EVIDENCE_NAME})`] : lines;
}

function requestLines(facts: FunnelFacts, affiliate: string, merchantSite: string | undefined): string[] {
	if (facts.party.role === "merchant") {
		return [
			`- terminate ${affiliate} in your affiliate program, and refuse its traffic through any network or sub-affiliate;`,
			"- withhold or claw back the commissions paid for this traffic, and refund the customers it brought in;",
			"- tell the network that delivered the traffic (named above) that you terminated the affiliate;",
		];
	}
	return [
		`- terminate ${affiliate} on your network and stop its campaigns${merchantSite ? `, including the one to ${merchantSite}` : ""};`,
		"- withhold or claw back the commissions earned through this traffic, and tell the advertiser;",
		"- check the sub IDs and click IDs above for the traffic source behind this affiliate;",
	];
}

/**
 * The mail of a deceptive-funnel report, to the merchant or a network's
 * operator (or its platform vendor): the affiliate to terminate, the
 * tracking links and their identifiers, what the lure claimed against what
 * it was, with verbatim page text, and the whole chain with timestamps.
 * Undefined for any other report; a funnel report whose facts are missing
 * throws rather than mail something else.
 */
export function createFunnelEmailDraft(input: FunnelDraftInput): FunnelEmailDraft | undefined {
	const party = parseFunnelPartyTarget(input.target.normalizedTarget);
	if (!party) return undefined;
	const facts = readFunnelFacts(input.evidence ?? []);
	if (!facts) throw new Error(`The funnel report for ${input.target.normalizedTarget} carries no readable ${FUNNEL_EVIDENCE_NAME}; it is not mailed without its facts.`);
	const allowed = new Set(input.target.observedUrls);
	const vendor = typeof input.route.resolutionSnapshot.platformVendor === "object" && input.route.resolutionSnapshot.platformVendor !== null
		? (input.route.resolutionSnapshot.platformVendor as { name?: unknown }).name
		: undefined;
	const vendorName = typeof vendor === "string" ? vendor : undefined;
	const viaVendor = routeContact(input.route.resolverProvenance).source === "platform_vendor";
	const label = input.route.providerDisplayName;
	const affiliate = facts.party.affiliateId ? `affiliate ${facts.party.affiliateId}` : "the affiliate behind this traffic";
	const merchantSite = facts.merchant?.site;
	const platform = platformName(facts.party.platform);
	const deception = DECEPTION_KINDS.includes(facts.deception.kind as DeceptionKind) ? DECEPTION_PHRASES[facts.deception.kind as DeceptionKind] : DECEPTION_PHRASES.other_misrepresentation;
	const recordedOn = facts.recordedAt.slice(0, 10);
	const opening = facts.party.role === "merchant"
		? `The phishing.support team, which analyses links people report as scams, is reporting ${affiliate}, which sends visitors to your offer on ${facts.party.site} through a deceptive funnel. On ${recordedOn} a link reported to us showed ${deception}, and its button led through affiliate tracking links to your offer.`
		: `The phishing.support team, which analyses links people report as scams, is reporting ${affiliate} on ${facts.party.site}${platform ? `, a ${platform} tracking domain` : ""}, which sends visitors${merchantSite ? ` to ${merchantSite}` : ""} through a deceptive funnel. On ${recordedOn} a link reported to us showed ${deception}, and its button led through this tracking domain${merchantSite ? ` to the paid offer on ${merchantSite}` : ""}.`;
	const lureQuotes = facts.deception.lureQuotes.map((quote) => `- ${JSON.stringify(quote.quote)} (${urlText(quote.url, allowed)}, captured ${quote.capturedAt})`);
	const offerQuote = facts.deception.offerQuote;
	const carried = facts.carriedValues.map(({ value, seenAt }) => `- ${value}: ${seenAt.map(({ site, parameter }) => `${parameter} on ${site}`).join(", ")}`);
	const attachmentNames = [...new Set(input.attachmentNames ?? [])];
	const caseUrl = input.report.submissionId ? `${serviceIdentity.url}/submissions/${input.report.submissionId.toString()}` : undefined;
	const body = [
		viaVendor ? `Hello ${label} team,` : `Hello ${label} affiliate compliance team,`,
		"",
		`${opening} ${contactSentence(input.route, facts, vendorName)}`,
		"",
		"Affiliate IDs, as each business in the chain knows them:",
		...affiliateLines(facts),
		"",
		"Tracking links in the chain:",
		...trackerLines(facts),
		...(facts.merchant?.identifiers.length ? [`- ${facts.merchant.site} landing page: ${facts.merchant.identifiers.map(identifierText).join(", ")}`] : []),
		"",
		"What the visitor was told, and what it was:",
		`- The lure claimed: ${facts.deception.claim}`,
		`- In reality: ${facts.deception.reality}`,
		"- The lure page shows, verbatim in its original language:",
		...lureQuotes.map((line) => `  ${line}`),
		...(offerQuote ? [`- The offer page shows: ${JSON.stringify(offerQuote.quote)} (${urlText(offerQuote.url, allowed)}, captured ${offerQuote.capturedAt})`] : []),
		"",
		`Redirect chain as our browser followed it (times in UTC):`,
		...chainLines(facts, allowed),
		...(carried.length ? ["", "Values the chain carried from one business to the next:", ...carried] : []),
		"",
		"We ask you to:",
		...requestLines(facts, affiliate, merchantSite),
		"- reply to this email with what you did.",
		"",
		attachmentNames.length
			? `Attached evidence: ${attachmentNames.join(", ")}. ${FUNNEL_EVIDENCE_NAME} holds the chain with every identifier; the screenshots are what our browser was shown.`
			: `The full chain with every identifier is in ${FUNNEL_EVIDENCE_NAME}.`,
		...(caseUrl ? [`Case details: ${caseUrl}`] : []),
		"",
		"Regards,",
		"The phishing.support team",
	].join("\n");
	const subjectAffiliate = facts.party.affiliateId ? `Affiliate ${facts.party.affiliateId}` : "An affiliate";
	const subject = facts.party.role === "merchant"
		? `${subjectAffiliate} sends deceptive traffic to ${facts.party.site}`
		: `${subjectAffiliate} on ${facts.party.site}${platform ? ` (${platform})` : ""} sends deceptive traffic${merchantSite ? ` to ${merchantSite}` : ""}`;
	return {
		subject: `[${serviceIdentity.name}] [${abuseCaseTag(input.report.id)}] ${subject}`,
		body: body.slice(0, MAX_BODY_LENGTH).trim(),
		recipientLabel: label,
	};
}

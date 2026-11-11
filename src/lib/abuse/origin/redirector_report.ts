import { SubmissionsEntity } from "../../db/entities";
import { defangUrl } from "../../malware/defang";
import type { ReporterMetadata } from "../../request_metadata";
import { hasPathTenants, websiteSite } from "../../website_site";
import type { ReportableWebsiteFinding } from "../../website_types";
import type { ValidatedAbuseReportRequest } from "../contracts";
import { linkedHostRequest, type PageScreenshot } from "../linked_host_report";
import { AbuseRepository, type CreatedAbuseReport } from "../repository";
import { sha256Hex } from "../security";
import { isPopularSite, loadPopularDomains, type PopularDomains } from "./popular_domains";
import { checkRedirector, redirectorOf, type RedirectorCheck, type RedirectorCheckDependencies, type RedirectorOf } from "./redirector_watch";

/** What the confirmed destination showed, from its own case. */
export type RedirectorDestination = { url: string; finding: ReportableWebsiteFinding; evidenceQuote?: string };

const FINDING_PHRASE = {
	credential_theft: "credential phishing",
	payment_fraud: "payment fraud",
	none: "phishing",
} as const;

function findingPhrase(finding: ReportableWebsiteFinding): string {
	return finding.finding === "malware" ? "malware distribution" : FINDING_PHRASE[finding.phishingBasis];
}

function checkStatement(check: RedirectorCheck & { checkedAt: string }, destinationUrl: string): string {
	if (check.kind === "stays") return `Checked again at ${check.checkedAt}: the URL still answers; it sends a browser on by script, which a plain HTTP request does not run.`;
	if (check.kind === "unreachable") return `Checked again at ${check.checkedAt}: the URL did not answer (${check.reason}).`;
	const how = check.page ? "serves a page that immediately sends the visitor on to" : "redirects to";
	const moved = websiteSite(check.url) !== websiteSite(destinationUrl)
		? " That is a new host: the campaign moves its pages to new hosts and keeps handing out this URL."
		: "";
	return `Checked again at ${check.checkedAt}: it ${how} ${defangUrl(check.url)}.${moved}`;
}

/**
 * The URL a campaign hands out (in its emails, its ads) that forwards each
 * visitor to its current phishing page. Taking it down stops every link
 * already sent from reaching any of the campaign's pages, including the ones
 * it moves to next. The description states what the URL did; it may be a
 * hijacked site rather than the operator's own.
 */
export function buildRedirectorRequest(params: {
	submissionId: bigint;
	sourceReportId: bigint;
	redirector: RedirectorOf;
	destination: RedirectorDestination;
	check: RedirectorCheck & { checkedAt: string };
	pageScreenshot?: PageScreenshot;
}): ValidatedAbuseReportRequest {
	const { redirector, destination, check } = params;
	const description = [
		`This URL forwards visitors to a confirmed ${findingPhrase(destination.finding)} page: on ${redirector.parent.createdAt.toISOString()} it sent our capture to ${defangUrl(destination.url)}, which we confirmed as ${findingPhrase(destination.finding)}.`,
		...(destination.evidenceQuote ? [`That page shows: ${JSON.stringify(destination.evidenceQuote)}.`] : []),
		checkStatement(check, destination.url),
		"Disabling this URL stops the links already handed out for this campaign from reaching its current page and the ones it moves to next.",
	].join("\n");
	return linkedHostRequest({
		submissionId: params.submissionId,
		kind: "redirector",
		// One report per redirector: the hosts it moves on to are found and
		// reported as their own cases, never as another report of this URL.
		scope: "host",
		allegationCategory: destination.finding.finding === "malware" ? "malware" : "phishing",
		url: redirector.url,
		description,
		originalRequest: {
			kind: "phishing_redirector",
			submissionId: params.submissionId.toString(),
			sourceReportId: params.sourceReportId.toString(),
			redirectorUrl: redirector.url,
			recorded: {
				capturedAt: redirector.parent.createdAt.toISOString(),
				caseId: redirector.parent.id.toString(),
				chain: redirector.parent.hops.map(({ url, status, redirectTo }) => ({ url, status, ...(redirectTo ? { redirectTo } : {}) })),
			},
			destination,
			check: {
				checkedAt: check.checkedAt,
				kind: check.kind,
				urls: check.urls,
				...(check.kind === "destination" ? { destination: check.url } : {}),
				...(check.kind === "unreachable" ? { reason: check.reason } : {}),
				...(check.page ? { page: { ...check.page, sha256: sha256Hex(check.page.html) } } : {}),
			},
		},
		evidenceName: "redirector-evidence.json",
		...(params.pageScreenshot ? { pageScreenshot: params.pageScreenshot } : {}),
	});
}

export type RedirectorReportDependencies = {
	loadPopularDomains?: () => Promise<PopularDomains>;
	checkRedirector?: (url: string, dependencies: RedirectorCheckDependencies) => Promise<RedirectorCheck>;
	now?: () => Date;
};

export type RedirectorReportOutcome =
	| { kind: "reported"; url: string; report: CreatedAbuseReport }
	| { kind: "skipped"; url: string; reason: string };

/**
 * Report the redirector a confirmed page was reached through, as a report of
 * its own linked to the page's case. A redirector that is a well-known
 * service (a mail provider's click tracker, a URL shortener, a site in the
 * Tranco top list) is left out: that is a service's own link, reported to
 * the service, not to its registrar. A redirector that no longer answers is
 * already gone.
 */
export async function reportRedirector(
	params: {
		reportId: bigint;
		submissionId: bigint;
		finding: ReportableWebsiteFinding;
		reporter: ReporterMetadata;
		pageScreenshot: () => Promise<PageScreenshot | undefined>;
		signal?: AbortSignal;
	},
	dependencies: RedirectorReportDependencies = {},
): Promise<RedirectorReportOutcome | undefined> {
	const redirector = await redirectorOf(params.submissionId);
	if (!redirector) return undefined;
	const { hostname } = new URL(redirector.url);
	if (hasPathTenants(hostname)) return { kind: "skipped", url: redirector.url, reason: "a shared link service, whose links are reported to the service itself" };
	if (isPopularSite(hostname, await (dependencies.loadPopularDomains ?? loadPopularDomains)())) {
		return { kind: "skipped", url: redirector.url, reason: "a well-known site (Tranco top list), such as a mail provider's click tracker" };
	}
	const checkedAt = (dependencies.now ?? (() => new Date()))().toISOString();
	const check = await (dependencies.checkRedirector ?? checkRedirector)(redirector.url, { signal: params.signal });
	if (check.kind === "unreachable") return { kind: "skipped", url: redirector.url, reason: `it no longer answers (${check.reason})` };

	const destination = await SubmissionsEntity.get(params.submissionId);
	const assessment = destination?.data.kind === "website"
		? destination.data.website.siteAssessments?.find(({ finding }) => finding === params.finding.finding)
		: undefined;
	const pageScreenshot = await params.pageScreenshot();
	const request = buildRedirectorRequest({
		submissionId: params.submissionId,
		sourceReportId: params.reportId,
		redirector,
		destination: { url: redirector.destinationUrl, finding: params.finding, ...(assessment?.evidenceQuote ? { evidenceQuote: assessment.evidenceQuote } : {}) },
		check: { ...check, checkedAt },
		...(pageScreenshot ? { pageScreenshot } : {}),
	});
	const report = await AbuseRepository.createReport({ request, reporter: params.reporter, submissionId: params.submissionId });
	return { kind: "reported", url: redirector.url, report };
}

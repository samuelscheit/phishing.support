import { isIP } from "node:net";

import { normalizePublicHost, normalizePublicHttpUrl } from "../../security";
import { asRecord } from "../../../values";
import { emailOriginFactLines, type EmailOrigin } from "../email_origin";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget, truncateProviderText } from "../report_payload";
import { isReportReference } from "../report_reference";
import { AWS_PROVIDER } from "./definition";

/** The durable, secret-free draft: the form values the submission sends, besides the time of filing. */
export type AwsSubmissionPayload = {
	adapter: "aws_report_v1";
	providerNarrativeVersion: 1;
	definition: { version: string; contentHash: string };
	target: { normalizedTarget: string };
	report: {
		/** `web_content` for a site; `email` for the IP that sent a phishing email. */
		abuseGroup: AwsAbuseGroup;
		abuseType: string;
		/** The sites; for an email, its links (none or up to ten). */
		urls: string[];
		trackingId: string;
		comments: string;
		/** `email` only: the message's header block, as the form's `email_header`. */
		emailHeader?: string;
	};
};

type AwsAbuseGroup = typeof AWS_PROVIDER.abuseGroup | typeof AWS_PROVIDER.emailAbuseGroup;

export type AwsReportInput = {
	target: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	legalBrandUrl?: string | null;
	/** The reference AWS quotes back in its mail. */
	trackingId: string;
	/** The page with the screenshots, since the form takes no files. */
	caseUrl?: string;
	/** `hostingAddressLine` of the route, when the target resolved to this hoster's address. */
	hostingLine?: string;
	/** Set when the target is the IP that sent the phishing email, which has no observed URL of its own. */
	emailOrigin?: EmailOrigin;
};

function validTrackingId(value: unknown): value is string {
	return isReportReference(value, AWS_PROVIDER.trackingIdMaximumLength);
}

/** The form splits its URL field on whitespace, so a URL with any would become two. */
function validUrl(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= AWS_PROVIDER.urlMaximumLength && !/\s/.test(value) && normalizePublicHttpUrl(value) === value;
}

/** The observed URLs the form can hold, in order; the host's root when none is. */
export function awsReportUrls(target: string, observedUrls: readonly string[]): string[] | undefined {
	const host = normalizePublicHost(target);
	if (!host) return undefined;
	const urls = new Set<string>();
	for (const value of observedUrls) {
		const url = normalizeObservedUrlForTarget(value, host);
		if (url && validUrl(url)) urls.add(url);
		if (urls.size >= AWS_PROVIDER.maximumUrls) break;
	}
	if (urls.size > 0) return [...urls];
	// An address that was never observed serving a page is not a site: no root URL is made up for it.
	if (isIP(host)) return undefined;
	const root = normalizePublicHttpUrl(`https://${host.includes(":") ? `[${host}]` : host}/`);
	return root && validUrl(root) ? [root] : undefined;
}

/**
 * The form replaces angle brackets with full-width ones, so none is sent. The
 * reference leads so that AWS's case mail quotes it; the form takes no files,
 * so the case page is where AWS finds the screenshots.
 */
export function makeAwsComments(input: AwsReportInput, urls: readonly string[]): string | undefined {
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	const narrative = buildProviderReportNarrative({
		provider: "aws",
		target: input.target,
		observedUrls: urls,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		maximumLength: AWS_PROVIDER.narrativeMaximumLength,
	});
	if (!narrative) return undefined;
	const comments = [
		`Reference: ${input.trackingId}`,
		narrative,
		input.hostingLine ? truncateProviderText(input.hostingLine, 600) : undefined,
		// The narrative ends with the preservation request; it is not repeated.
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part).join("\n\n").replace(/[<>]/g, " ");
	return comments.length <= AWS_PROVIDER.commentsMaximumLength ? comments : undefined;
}

/** The form's own sanitising of `email_header` and `comments` (`sanitizeAbuseInput`): markup, event handlers and `javascript:` are defused. */
function sanitizeLikeTheForm(value: string): string {
	return value.replace(/</g, "＜").replace(/>/g, "＞").replace(/(\s)(on)(\w+)(=)/gi, "$1$2-$3$4").replace(/javascript:/gi, "javascript[colon]");
}

/** The email's header block as the form sends it: sanitised, whole lines only, within `email_header`'s limit. */
export function awsEmailHeader(headers: string): string | undefined {
	const maximum = AWS_PROVIDER.emailHeaderMaximumLength;
	const lines = sanitizeLikeTheForm(headers).split("\n");
	const kept: string[] = [];
	let length = 0;
	for (const line of lines) {
		const next = length + (kept.length ? 1 : 0) + line.length;
		if (next > maximum) break;
		kept.push(line);
		length = next;
	}
	const header = kept.join("\n").trim();
	return header || undefined;
}

/** The email's links the form can hold: valid, deduplicated, at most ten. */
export function awsEmailUrls(links: readonly string[]): string[] {
	return [...new Set(links.filter(validUrl))].slice(0, AWS_PROVIDER.maximumUrls);
}

/**
 * The comments for the IP that sent a phishing email: the reference, the
 * narrative, the hop that proves it, the links the email pushes (as many as
 * fit) and the case page. The headers themselves are the `email_header` field.
 */
export function makeAwsEmailComments(input: AwsReportInput, origin: EmailOrigin, capturedAt: Date): string | undefined {
	if (!isIP(input.target)) return undefined;
	const legalBrandUrl = input.legalBrandUrl ? normalizePublicHttpUrl(input.legalBrandUrl, { domainOnly: true }) : undefined;
	const links = awsEmailUrls(origin.links);
	const narrative = buildProviderReportNarrative({
		provider: "aws",
		target: input.target,
		observedUrls: links,
		description: input.description,
		...(input.allegationCategory ? { allegationCategory: input.allegationCategory } : {}),
		...(legalBrandUrl ? { legalBrandUrl } : {}),
		source: "email",
		maximumLength: AWS_PROVIDER.narrativeMaximumLength,
	});
	if (!narrative) return undefined;
	const maximum = AWS_PROVIDER.commentsMaximumLength;
	const compose = (listed: readonly string[]) => [
		`Reference: ${input.trackingId}`,
		narrative,
		emailOriginFactLines(input.target, origin, capturedAt).join("\n"),
		listed.length ? `Phishing URLs in the email:\n${listed.map((url) => `- ${url}`).join("\n")}` : undefined,
		input.hostingLine ? truncateProviderText(input.hostingLine, 600) : undefined,
		input.caseUrl ? `Case details and screenshots: ${input.caseUrl}` : undefined,
	].filter((part): part is string => !!part).join("\n\n").replace(/[<>]/g, " ");
	// A link that does not fit is skipped, not cut; a shorter one may still fit.
	const listed: string[] = [];
	for (const url of links) if (compose([...listed, url]).length <= maximum) listed.push(url);
	const comments = compose(listed);
	return comments.length <= maximum ? comments : undefined;
}

function buildAwsEmailPayload(input: AwsReportInput, target: string, origin: EmailOrigin, capturedAt: Date): AwsSubmissionPayload | undefined {
	if (!isIP(target)) return undefined;
	const emailHeader = awsEmailHeader(origin.headers);
	const comments = makeAwsEmailComments({ ...input, target }, origin, capturedAt);
	if (!emailHeader || !comments) return undefined;
	return {
		adapter: "aws_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: AWS_PROVIDER.version, contentHash: AWS_PROVIDER.contentHash },
		target: { normalizedTarget: target },
		report: {
			abuseGroup: AWS_PROVIDER.emailAbuseGroup,
			abuseType: AWS_PROVIDER.emailAbuseType,
			urls: awsEmailUrls(origin.links),
			trackingId: input.trackingId,
			comments,
			emailHeader,
		},
	};
}

/** `capturedAt` stands in for the hop's time when no Received header states one. */
export function buildAwsSubmissionPayload(input: AwsReportInput & { capturedAt?: Date }): AwsSubmissionPayload | undefined {
	const normalizedTarget = normalizePublicHost(input.target);
	if (!normalizedTarget || !validTrackingId(input.trackingId)) return undefined;
	if (input.emailOrigin) return buildAwsEmailPayload(input, normalizedTarget, input.emailOrigin, input.capturedAt ?? new Date());
	const urls = awsReportUrls(normalizedTarget, input.observedUrls);
	if (!urls) return undefined;
	const comments = makeAwsComments({ ...input, target: normalizedTarget }, urls);
	if (!comments) return undefined;
	return {
		adapter: "aws_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: AWS_PROVIDER.version, contentHash: AWS_PROVIDER.contentHash },
		target: { normalizedTarget },
		report: {
			abuseGroup: AWS_PROVIDER.abuseGroup,
			abuseType: input.allegationCategory === "malware" ? AWS_PROVIDER.abuseTypes.malware : AWS_PROVIDER.abuseTypes.phishing,
			urls,
			trackingId: input.trackingId,
			comments,
		},
	};
}

/** Read a stored draft: only the exact shape this adapter writes, for the pinned definition. */
export function storedAwsSubmissionPayload(value: unknown): AwsSubmissionPayload | undefined {
	const payload = asRecord(value);
	const definition = asRecord(payload?.definition);
	const target = asRecord(payload?.target);
	const report = asRecord(payload?.report);
	if (!payload || payload.adapter !== "aws_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== AWS_PROVIDER.version || definition.contentHash !== AWS_PROVIDER.contentHash
		|| typeof target?.normalizedTarget !== "string" || !report
		|| !validTrackingId(report.trackingId)
		|| !Array.isArray(report.urls) || report.urls.length > AWS_PROVIDER.maximumUrls || !report.urls.every(validUrl)
		|| typeof report.comments !== "string" || report.comments.length === 0 || report.comments.length > AWS_PROVIDER.commentsMaximumLength || /[<>]/.test(report.comments)) return undefined;
	const base = {
		adapter: "aws_report_v1" as const,
		providerNarrativeVersion: 1 as const,
		definition: { version: AWS_PROVIDER.version, contentHash: AWS_PROVIDER.contentHash },
		target: { normalizedTarget: target.normalizedTarget },
	};
	const common = { trackingId: report.trackingId, comments: report.comments };
	const urls = [...report.urls as string[]];
	if (report.abuseGroup === AWS_PROVIDER.emailAbuseGroup) {
		const header = report.emailHeader;
		if (report.abuseType !== AWS_PROVIDER.emailAbuseType || !isIP(target.normalizedTarget)
			|| typeof header !== "string" || header.trim().length === 0 || header.length > AWS_PROVIDER.emailHeaderMaximumLength || /[<>]/.test(header)) return undefined;
		return { ...base, report: { abuseGroup: AWS_PROVIDER.emailAbuseGroup, abuseType: AWS_PROVIDER.emailAbuseType, urls, ...common, emailHeader: header } };
	}
	const abuseTypes: readonly unknown[] = Object.values(AWS_PROVIDER.abuseTypes);
	if (report.abuseGroup !== AWS_PROVIDER.abuseGroup || !abuseTypes.includes(report.abuseType) || urls.length === 0 || report.emailHeader !== undefined) return undefined;
	return { ...base, report: { abuseGroup: AWS_PROVIDER.abuseGroup, abuseType: report.abuseType as string, urls, ...common } };
}

/** The form's timestamp: the time of filing, to the minute, in UTC. */
export function awsEventTimestamp(now: Date): string {
	return `${new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString().slice(0, 16)}:00+00:00`;
}

/** The request body the form posts. */
export function awsRequestBody(payload: AwsSubmissionPayload, now: Date) {
	const timestamp = awsEventTimestamp(now);
	const { report } = payload;
	const reporter = {
		first_name: AWS_PROVIDER.reporter.firstName,
		last_name: AWS_PROVIDER.reporter.lastName,
		email_address: AWS_PROVIDER.reporter.email,
		phone: AWS_PROVIDER.reporter.phone,
		organization: AWS_PROVIDER.reporter.organization,
		description: AWS_PROVIDER.reporter.description,
		tracking_id: report.trackingId,
	};
	const common = { abuse_source: AWS_PROVIDER.abuseSource, abuse_group: report.abuseGroup, abuse_type: report.abuseType };
	if (report.abuseGroup === AWS_PROVIDER.emailAbuseGroup) {
		// The form repeats the header in one event per URL (`expandUrlEvents`), or sends one event with an empty URL.
		const email_events = (report.urls.length ? report.urls : [""]).map((email_url) => ({ email_header: report.emailHeader, email_url, timestamp }));
		return { content: { message: { ...common, reporter, email_events, comments: report.comments } } };
	}
	return {
		content: {
			message: {
				...common,
				web_content_events: report.urls.map((url) => ({ web_content_url: url, timestamp })),
				comments: report.comments,
				reporter,
			},
		},
	};
}

import { isIP } from "node:net";
import { z } from "zod";

import { normalizePublicHost } from "../../security";
import { emailOriginFactLines, type EmailOrigin } from "../email_origin";
import type { ReportInput } from "../kit/draft";
import { field, payloadEnvelope, storedReader } from "../kit/stored";
import { composeFreeText, isReportUrl, providerNarrative, reportUrls, type UrlRules } from "../kit/text";
import { truncateAtWord } from "../../../util/text";
import { isReportReference } from "../report_reference";
import { AWS_PROVIDER } from "./definition";

const envelope = payloadEnvelope(AWS_PROVIDER, "aws_report_v1");
/** The form splits its URL field on whitespace, so a URL with any would become two. */
const URL_RULES: UrlRules = { maximumLength: AWS_PROVIDER.urlMaximumLength, maximum: AWS_PROVIDER.maximumUrls };
const unmarked = (value: string) => !/[<>]/.test(value);

const common = {
	trackingId: z.string().refine((value) => isReportReference(value, AWS_PROVIDER.trackingIdMaximumLength)),
	urls: z.array(field.url(URL_RULES.maximumLength)).max(AWS_PROVIDER.maximumUrls),
	comments: field.text(AWS_PROVIDER.commentsMaximumLength).refine(unmarked),
};

/** The durable, secret-free draft: the form values the submission sends, besides the time of filing. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ normalizedTarget: z.string() }),
	report: z.discriminatedUnion("abuseGroup", [
		/** A site; `urls` are its pages. */
		z.object({
			...common,
			abuseGroup: z.literal(AWS_PROVIDER.abuseGroup),
			abuseType: z.string().refine((type) => (Object.values(AWS_PROVIDER.abuseTypes) as readonly string[]).includes(type)),
			urls: common.urls.min(1),
			emailHeader: z.undefined().optional(),
		}),
		/** The IP that sent a phishing email: its links (none or up to ten) and the message's header block, as the form's `email_header`. */
		z.object({
			...common,
			abuseGroup: z.literal(AWS_PROVIDER.emailAbuseGroup),
			abuseType: z.literal(AWS_PROVIDER.emailAbuseType),
			emailHeader: z.string().refine((header) => header.trim().length > 0 && header.length <= AWS_PROVIDER.emailHeaderMaximumLength && unmarked(header)),
		}),
	]),
}).refine((payload) => payload.report.abuseGroup !== AWS_PROVIDER.emailAbuseGroup || isIP(payload.target.normalizedTarget));

export type AwsSubmissionPayload = z.infer<typeof payloadSchema>;

/** `trackingId` is the reference AWS quotes back in its mail; the case page holds the screenshots, since the form takes no files. */
export type AwsReportInput = ReportInput & {
	/** Set when the target is the IP that sent the phishing email, which has no observed URL of its own. */
	emailOrigin?: EmailOrigin;
};

/** The observed URLs the form can hold, in order; the host's root when none is. */
export function awsReportUrls(target: string, observedUrls: readonly string[]): string[] | undefined {
	const host = normalizePublicHost(target);
	if (!host) return undefined;
	// An address that was never observed serving a page is not a site: no root URL is made up for it.
	const urls = reportUrls(host, observedUrls, { ...URL_RULES, rootFallback: !isIP(host) });
	return urls.length > 0 ? urls : undefined;
}

/**
 * The form replaces angle brackets with full-width ones, so none is sent. The
 * reference leads so that AWS's case mail quotes it; the narrative ends with
 * the preservation request, which is not repeated.
 */
export function makeAwsComments(input: AwsReportInput, urls: readonly string[]): string | undefined {
	return composeFreeText({
		provider: "aws",
		input,
		urls,
		limit: AWS_PROVIDER.commentsMaximumLength,
		before: [`Reference: ${input.trackingId}`],
		hostingLimit: 600,
		narrative: { maximum: AWS_PROVIDER.narrativeMaximumLength },
	})?.replace(/[<>]/g, " ");
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
function awsEmailUrls(links: readonly string[]): string[] {
	return [...new Set(links.filter((link) => isReportUrl(link, URL_RULES)))].slice(0, AWS_PROVIDER.maximumUrls);
}

/**
 * The comments for the IP that sent a phishing email: the reference, the
 * narrative, the hop that proves it, the links the email pushes (as many as
 * fit) and the case page. The headers themselves are the `email_header` field.
 */
export function makeAwsEmailComments(input: AwsReportInput, origin: EmailOrigin, capturedAt: Date): string | undefined {
	if (!isIP(input.target)) return undefined;
	const links = awsEmailUrls(origin.links);
	const narrative = providerNarrative("aws", { ...input, observedUrls: links, source: "email" }, AWS_PROVIDER.narrativeMaximumLength);
	if (!narrative) return undefined;
	const maximum = AWS_PROVIDER.commentsMaximumLength;
	const compose = (listed: readonly string[]) => [
		`Reference: ${input.trackingId}`,
		narrative,
		emailOriginFactLines(input.target, origin, capturedAt).join("\n"),
		listed.length ? `Phishing URLs in the email:\n${listed.map((url) => `- ${url}`).join("\n")}` : undefined,
		input.hostingLine ? truncateAtWord(input.hostingLine, 600) : undefined,
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
		...envelope.stamp,
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
	if (!normalizedTarget || !isReportReference(input.trackingId, AWS_PROVIDER.trackingIdMaximumLength)) return undefined;
	if (input.emailOrigin) return buildAwsEmailPayload(input, normalizedTarget, input.emailOrigin, input.capturedAt ?? new Date());
	const urls = awsReportUrls(normalizedTarget, input.observedUrls);
	if (!urls) return undefined;
	const comments = makeAwsComments({ ...input, target: normalizedTarget }, urls);
	if (!comments) return undefined;
	return {
		...envelope.stamp,
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
export const storedAwsSubmissionPayload = storedReader(payloadSchema);

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

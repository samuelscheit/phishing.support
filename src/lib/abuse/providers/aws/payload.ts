import { normalizePublicHost, normalizePublicHttpUrl } from "../../security";
import { asRecord } from "../../../values";
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
		abuseType: string;
		urls: string[];
		trackingId: string;
		comments: string;
	};
};

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

export function buildAwsSubmissionPayload(input: AwsReportInput): AwsSubmissionPayload | undefined {
	const normalizedTarget = normalizePublicHost(input.target);
	const urls = normalizedTarget ? awsReportUrls(normalizedTarget, input.observedUrls) : undefined;
	if (!normalizedTarget || !urls || !validTrackingId(input.trackingId)) return undefined;
	const comments = makeAwsComments({ ...input, target: normalizedTarget }, urls);
	if (!comments) return undefined;
	return {
		adapter: "aws_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: AWS_PROVIDER.version, contentHash: AWS_PROVIDER.contentHash },
		target: { normalizedTarget },
		report: {
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
	const abuseTypes: readonly unknown[] = Object.values(AWS_PROVIDER.abuseTypes);
	if (!payload || payload.adapter !== "aws_report_v1" || payload.providerNarrativeVersion !== 1
		|| definition?.version !== AWS_PROVIDER.version || definition.contentHash !== AWS_PROVIDER.contentHash
		|| typeof target?.normalizedTarget !== "string" || !report
		|| !abuseTypes.includes(report.abuseType) || !validTrackingId(report.trackingId)
		|| !Array.isArray(report.urls) || report.urls.length === 0 || report.urls.length > AWS_PROVIDER.maximumUrls || !report.urls.every(validUrl)
		|| typeof report.comments !== "string" || report.comments.length === 0 || report.comments.length > AWS_PROVIDER.commentsMaximumLength || /[<>]/.test(report.comments)) return undefined;
	return {
		adapter: "aws_report_v1",
		providerNarrativeVersion: 1,
		definition: { version: AWS_PROVIDER.version, contentHash: AWS_PROVIDER.contentHash },
		target: { normalizedTarget: target.normalizedTarget },
		report: { abuseType: report.abuseType as string, urls: [...report.urls as string[]], trackingId: report.trackingId, comments: report.comments },
	};
}

/** The form's timestamp: the time of filing, to the minute, in UTC. */
export function awsEventTimestamp(now: Date): string {
	return `${new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString().slice(0, 16)}:00+00:00`;
}

/** The request body the form posts. */
export function awsRequestBody(payload: AwsSubmissionPayload, now: Date) {
	const timestamp = awsEventTimestamp(now);
	return {
		content: {
			message: {
				abuse_source: AWS_PROVIDER.abuseSource,
				abuse_group: AWS_PROVIDER.abuseGroup,
				abuse_type: payload.report.abuseType,
				web_content_events: payload.report.urls.map((url) => ({ web_content_url: url, timestamp })),
				comments: payload.report.comments,
				reporter: {
					first_name: AWS_PROVIDER.reporter.firstName,
					last_name: AWS_PROVIDER.reporter.lastName,
					email_address: AWS_PROVIDER.reporter.email,
					phone: AWS_PROVIDER.reporter.phone,
					organization: AWS_PROVIDER.reporter.organization,
					description: AWS_PROVIDER.reporter.description,
					tracking_id: payload.report.trackingId,
				},
			},
		},
	};
}

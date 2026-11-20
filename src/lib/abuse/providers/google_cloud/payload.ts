import { isIP } from "node:net";
import { z } from "zod";

import { domainMatchesOrIsSubdomain, normalizePublicHost } from "../../security";
import { utcStamp, type EmailOrigin } from "../email_origin";
import { field, payloadEnvelope, storedReader } from "../kit/stored";
import { truncateAtWord } from "../../../util/text";
import { buildProviderReportNarrative, normalizeObservedUrlForTarget } from "../report_payload";
import { GOOGLE_CLOUD_PROVIDER, GOOGLE_CLOUD_SERVICES, type GoogleCloudService } from "./definition";

const envelope = payloadEnvelope(GOOGLE_CLOUD_PROVIDER, "google_cloud_abuse_report_v1");

const isoTime = z.string().refine((at) => Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at);

/** The immutable form draft. */
const payloadSchema = z.object({
	...envelope.shape,
	target: z.object({ normalizedTarget: z.string(), observedUrls: z.array(z.string()) }),
	/** Set when the target is the IP that sent a phishing email, which has no observed URL of its own. */
	emailOrigin: z.object({
		/** The email's links, which are the abusive URLs. */
		links: z.array(field.url(Number.MAX_SAFE_INTEGER)),
		/** The UTC time the sending hop's Received header states. */
		receivedAt: isoTime.optional(),
	}).optional(),
	report: z.object({
		service: z.enum(GOOGLE_CLOUD_SERVICES),
		/** MM/DD/YYYY, the form's own date format, in UTC. */
		abuseDate: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
		abuseDetails: field.text(GOOGLE_CLOUD_PROVIDER.abuseDetailsMaximumLength),
	}),
}).refine(({ target, emailOrigin, report }) => {
	const { normalizedTarget, observedUrls } = target;
	return normalizePublicHost(normalizedTarget) === normalizedTarget
		// A draft names observed URLs, or is the origin of an email; never neither.
		&& (!emailOrigin || isIP(normalizedTarget))
		&& (observedUrls.length > 0 || emailOrigin !== undefined)
		&& observedUrls.every((url) => normalizeObservedUrlForTarget(url, normalizedTarget) === url)
		&& report.service === googleCloudServiceForTarget(normalizedTarget);
});

export type GoogleCloudSubmissionPayload = z.infer<typeof payloadSchema>;

/** Hosts whose Google Cloud product is known from the name alone. */
const SERVICE_BY_HOST: readonly { domain: string; service: GoogleCloudService }[] = [
	{ domain: "storage.googleapis.com", service: "cloud_storage" },
	{ domain: "storage.cloud.google.com", service: "cloud_storage" },
	{ domain: "firebasestorage.googleapis.com", service: "cloud_storage" },
	{ domain: "appspot.com", service: "google_app_engine" },
];

/**
 * The form's service for a target. A Google address is a Compute Engine
 * instance; other Google hosts (sites.google.com, script.google.com) are
 * not Cloud products the form lists, so Google triages them.
 */
export function googleCloudServiceForTarget(target: string): GoogleCloudService {
	if (isIP(target)) return "compute_engine";
	return SERVICE_BY_HOST.find(({ domain }) => domainMatchesOrIsSubdomain(target, domain))?.service ?? "n_a";
}

/** The form's MM/DD/YYYY date of the abuse, which is when the page was captured. */
export function googleCloudAbuseDate(capturedAt: Date): string {
	const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
	const day = String(capturedAt.getUTCDate()).padStart(2, "0");
	return `${month}/${day}/${capturedAt.getUTCFullYear()}`;
}

export type GoogleCloudReportInput = {
	target?: string;
	observedUrls: readonly string[];
	description: string;
	allegationCategory?: string;
	capturedAt: Date;
	caseUrl?: string;
	legalBrandUrl?: string;
	/** The email the target sent, when the target is an email's sending IP rather than a web host. */
	emailOrigin?: EmailOrigin;
};

/** Narrative room the email-origin details keep free after the IP, the time and as many links as fit. */
const EMAIL_NARRATIVE_RESERVE = 250;
const NARRATIVE_MINIMUM = 80;

function narrativeFor(params: GoogleCloudReportInput, room: number, source: "page" | "email"): string | undefined {
	if (room <= NARRATIVE_MINIMUM || !params.target) return undefined;
	return buildProviderReportNarrative({
		provider: "google_cloud",
		target: params.target,
		observedUrls: params.emailOrigin?.links ?? params.observedUrls,
		description: params.description,
		...(params.allegationCategory ? { allegationCategory: params.allegationCategory } : {}),
		...(params.legalBrandUrl !== undefined ? { legalBrandUrl: params.legalBrandUrl } : {}),
		source,
		maximumLength: room,
	});
}

/**
 * An IP that sent a phishing email has no URL of its own: the form gets the
 * address, the Received header that proves the hop and its time, the email's
 * links and the case page, then the narrative.
 */
function makeEmailOriginAbuseDetails(params: GoogleCloudReportInput, origin: EmailOrigin): string | undefined {
	const target = params.target;
	if (!target || !isIP(target)) return undefined;
	const maximum = GOOGLE_CLOUD_PROVIDER.abuseDetailsMaximumLength;
	const head = [
		`Abusive IP address: ${target} (first external Received hop of a phishing email sent from it)`,
		origin.received ? `Received header: ${truncateAtWord(origin.received.line, 300)}` : undefined,
	];
	const tail = [
		`Date and time of the abuse: ${utcStamp(origin.received?.at ?? params.capturedAt)} (UTC).`,
		params.caseUrl ? `Evidence (email source, screenshot, analysis): ${params.caseUrl}` : undefined,
	];
	const fixed = [...head, ...tail].filter((line): line is string => Boolean(line));
	const fit = (reserve: number) => {
		let length = fixed.join("\n").length + "\nPhishing URLs in the email:".length;
		const lines: string[] = [];
		for (const link of origin.links) {
			const next = length + `\n- ${link}`.length;
			// A link too long for what is left is skipped; a shorter one may still fit.
			if (next > maximum - reserve) continue;
			length = next;
			lines.push(`- ${link}`);
		}
		return lines;
	};
	const links = fit(EMAIL_NARRATIVE_RESERVE);
	if (links.length === 0) links.push(...fit(0));
	const block = [
		...head,
		links.length ? "Phishing URLs in the email:" : undefined,
		...links,
		...tail,
	].filter((line): line is string => Boolean(line)).join("\n");
	const narrative = narrativeFor(params, maximum - block.length - 2, "email");
	if (params.legalBrandUrl !== undefined && maximum - block.length - 2 > NARRATIVE_MINIMUM && !narrative) return undefined;
	const details = [block, narrative].filter(Boolean).join("\n\n");
	return details.length <= maximum ? details : truncateAtWord(block, maximum);
}

/**
 * Google asks for every abusive URL or IP address in the details field, and
 * for the date, time and time zone of the abuse. The URLs lead, so they
 * survive the 1,000-character limit; the narrative fills what remains.
 */
export function makeGoogleCloudAbuseDetails(params: GoogleCloudReportInput): string | undefined {
	if (!params.target) return undefined;
	if (params.emailOrigin) return makeEmailOriginAbuseDetails(params, params.emailOrigin);
	if (params.observedUrls.length === 0) return undefined;
	const maximum = GOOGLE_CLOUD_PROVIDER.abuseDetailsMaximumLength;
	const urls = `Abusive URLs:\n${params.observedUrls.map((url) => `- ${url}`).join("\n")}`;
	const observed = `Observed: ${utcStamp(params.capturedAt)} (UTC).`;
	const evidence = params.caseUrl ? `Evidence (screenshot, archived page, analysis): ${params.caseUrl}` : "";
	const fixed = [urls, observed, evidence].filter(Boolean).join("\n");
	const narrativeRoom = maximum - fixed.length - 2;
	const narrative = narrativeFor(params, narrativeRoom, "page");
	if (params.legalBrandUrl !== undefined && narrativeRoom > NARRATIVE_MINIMUM && !narrative) return undefined;
	const details = [narrative, fixed].filter(Boolean).join("\n\n");
	return details.length <= maximum ? details : truncateAtWord(urls, maximum);
}

/** Build the immutable form draft before the browser boundary. */
export function buildGoogleCloudSubmissionPayload(params: GoogleCloudReportInput & { target: string }): GoogleCloudSubmissionPayload | undefined {
	const target = normalizePublicHost(params.target);
	if (!target) return undefined;
	const observedUrls = [...new Set(params.observedUrls.map((url) => normalizeObservedUrlForTarget(url, target)).filter((url): url is string => Boolean(url)))];
	const emailOrigin = params.emailOrigin && isIP(target) ? params.emailOrigin : undefined;
	if (params.emailOrigin && !emailOrigin) return undefined;
	if (observedUrls.length === 0 && !emailOrigin) return undefined;
	const abuseDetails = makeGoogleCloudAbuseDetails({ ...params, target, observedUrls, ...(emailOrigin ? { emailOrigin } : {}) });
	if (!abuseDetails) return undefined;
	return {
		...envelope.stamp,
		target: { normalizedTarget: target, observedUrls },
		...(emailOrigin ? { emailOrigin: { links: emailOrigin.links, ...(emailOrigin.received ? { receivedAt: emailOrigin.received.at.toISOString() } : {}) } } : {}),
		report: {
			service: googleCloudServiceForTarget(target),
			abuseDate: googleCloudAbuseDate(emailOrigin?.received?.at ?? params.capturedAt),
			abuseDetails,
		},
	};
}

/** Read only an immutable draft produced by this provider. */
export const storedGoogleCloudSubmissionPayload = storedReader(payloadSchema);

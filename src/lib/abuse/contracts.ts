import { isIP } from "node:net";

import sharp from "sharp";
import { z } from "zod";

import { AbuseInputError, domainMatchesOrIsSubdomain, hashStableJson, isPublicIp, normalizeDomain, sha256Hex } from "./security";

export const MAX_TARGETS_PER_REPORT = 100;
export const MAX_OBSERVED_URLS_PER_TARGET = 100;
export const MAX_EVIDENCE_ITEMS = 15;
export const MAX_EVIDENCE_BYTES_PER_ITEM = 5 * 1024 * 1024;
export const MAX_EVIDENCE_BYTES_PER_REPORT = 20 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

export const allegationCategories = ["phishing", "fraud", "malware", "impersonation", "copyright", "other"] as const;

const evidenceSchema = z
	.object({
		filename: z.string().trim().min(1).max(180),
		mimeType: z.string().trim().min(1).max(100),
		base64: z.string().min(1).max(Math.ceil(MAX_EVIDENCE_BYTES_PER_ITEM * 4 / 3) + 16),
	})
	.strict();

const observedUrlsSchema = z
	.object({
		target: z.string().trim().min(1).max(253),
		urls: z.array(z.string().trim().min(1).max(4_096)).min(1).max(MAX_OBSERVED_URLS_PER_TARGET),
	})
	.strict();

export const abuseReportRequestSchema = z
	.object({
		targets: z.array(z.string().min(1).max(253)).min(1).max(MAX_TARGETS_PER_REPORT),
		allegationCategory: z.enum(allegationCategories),
		description: z.string().trim().min(1).max(30_000),
		observedUrls: z.array(observedUrlsSchema).max(MAX_TARGETS_PER_REPORT).optional(),
		legalBrandUrl: z.string().trim().url().max(4_096).optional(),
		reporterContactEmail: z.string().trim().email().max(320).optional(),
		reporterIdentity: z.enum(["service", "submitter"]).optional(),
		evidence: z.array(evidenceSchema).max(MAX_EVIDENCE_ITEMS).optional(),
		idempotencyKey: z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/).optional(),
	})
	.strict();

export type AbuseReportRequest = z.infer<typeof abuseReportRequestSchema>;

export type NormalizedAbuseTarget = {
	ordinal: number;
	originalInput: string;
	originalInputs: string[];
	normalizedTarget: string;
	targetType: "domain" | "ip";
	observedUrls: string[];
};

export type DecodedEvidence = {
	filename: string;
	mimeType: "image/jpeg" | "image/png" | "image/webp";
	buffer: Buffer;
	sha256: string;
};

export type ValidatedAbuseReportRequest = {
	originalRequest: AbuseReportRequest;
	targets: NormalizedAbuseTarget[];
	allegationCategory: (typeof allegationCategories)[number];
	description: string;
	observedUrls: Array<{ target: string; urls: string[] }>;
	legalBrandUrl?: string;
	reporterContactEmail?: string;
	reporterIdentity: "service" | "submitter";
	evidence: DecodedEvidence[];
	idempotencyKey?: string;
	requestPayloadHash: string;
};

function schemaError(error: z.ZodError): never {
	const issue = error.issues[0];
	const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
	throw new AbuseInputError(`${path}${issue?.message ?? "Invalid abuse report request."}`);
}

export function normalizeAbuseTarget(value: string): { normalizedTarget: string; targetType: "domain" | "ip" } {
	const original = value.trim();
	if (!original) throw new AbuseInputError("A report target cannot be empty.");
	if (isIP(original)) {
		if (!isPublicIp(original)) throw new AbuseInputError(`Target ${original} is not a public routable IP address.`);
		return { normalizedTarget: original.toLowerCase(), targetType: "ip" };
	}
	const domain = normalizeDomain(original);
	if (!domain) throw new AbuseInputError(`Target ${original} is not a public domain or IP address.`);
	return { normalizedTarget: domain, targetType: "domain" };
}

function normalizeObservedUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AbuseInputError(`Observed URL ${value} is invalid.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new AbuseInputError("Observed URLs must use http or https.");
	if (url.username || url.password) throw new AbuseInputError("Observed URLs must not contain credentials.");
	if (isIP(url.hostname)) throw new AbuseInputError("Observed URLs must be associated with a submitted domain, not a raw IP address.");
	const hostname = normalizeDomain(url.hostname);
	if (!hostname) throw new AbuseInputError("Observed URL hostname must be a public domain.");
	url.hostname = hostname;
	url.hash = "";
	return url.toString();
}

function normalizeLegalBrandUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AbuseInputError("Legal brand URL is invalid.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new AbuseInputError("Legal brand URL must use http or https.");
	if (url.username || url.password || isIP(url.hostname) || !normalizeDomain(url.hostname)) {
		throw new AbuseInputError("Legal brand URL must use a public domain without credentials.");
	}
	url.hostname = normalizeDomain(url.hostname)!;
	url.hash = "";
	return url.toString();
}

function strictBase64(value: string): Buffer {
	if (value.startsWith("data:") || /\s/.test(value) || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		throw new AbuseInputError("Evidence must be a plain base64 string, not a data URL.");
	}
	const unpadded = value.replace(/=+$/, "");
	if (unpadded.length % 4 === 1) throw new AbuseInputError("Evidence base64 is malformed.");
	const padded = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
	const buffer = Buffer.from(padded, "base64");
	if (buffer.byteLength === 0 || buffer.toString("base64").replace(/=+$/, "") !== unpadded) {
		throw new AbuseInputError("Evidence base64 is malformed.");
	}
	return buffer;
}

async function decodeEvidence(item: z.infer<typeof evidenceSchema>): Promise<DecodedEvidence> {
	const buffer = strictBase64(item.base64);
	if (buffer.byteLength > MAX_EVIDENCE_BYTES_PER_ITEM) {
		throw new AbuseInputError(`Evidence ${item.filename} exceeds the ${MAX_EVIDENCE_BYTES_PER_ITEM / 1024 / 1024} MB item limit.`, 413);
	}

	let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
	try {
		metadata = await sharp(buffer, { limitInputPixels: 40_000_000, failOn: "error" }).metadata();
	} catch {
		throw new AbuseInputError(`Evidence ${item.filename} is not a decodable image.`);
	}
	const mimeByFormat = {
		jpeg: "image/jpeg",
		png: "image/png",
		webp: "image/webp",
	} as const;
	const decodedMimeType = metadata.format ? mimeByFormat[metadata.format as keyof typeof mimeByFormat] : undefined;
	if (!decodedMimeType) throw new AbuseInputError("Evidence must decode to a JPEG, PNG, or WebP image.");
	const claimedMimeType = item.mimeType.toLowerCase().split(";", 1)[0].trim();
	if (claimedMimeType !== decodedMimeType) {
		throw new AbuseInputError(`Evidence ${item.filename} MIME type does not match its decoded image content.`);
	}
	return { filename: sanitizeFilename(item.filename), mimeType: decodedMimeType, buffer, sha256: sha256Hex(buffer) };
}

function sanitizeFilename(value: string): string {
	const filename = value.replace(/[\u0000-\u001F\u007F\\/]/g, "_").trim().slice(0, 180);
	if (!filename) throw new AbuseInputError("Evidence filename is invalid.");
	return filename;
}

export async function validateAbuseReportRequest(value: unknown): Promise<ValidatedAbuseReportRequest> {
	const parsed = abuseReportRequestSchema.safeParse(value);
	if (!parsed.success) schemaError(parsed.error);
	const input = parsed.data;

	const targetByNormalized = new Map<string, NormalizedAbuseTarget>();
	for (const [inputIndex, originalInput] of input.targets.entries()) {
		const normalized = normalizeAbuseTarget(originalInput);
		const existing = targetByNormalized.get(normalized.normalizedTarget);
		if (existing) {
			existing.originalInputs.push(originalInput);
			continue;
		}
		targetByNormalized.set(normalized.normalizedTarget, {
			ordinal: inputIndex,
			originalInput,
			originalInputs: [originalInput],
			...normalized,
			observedUrls: [],
		});
	}
	const targets = [...targetByNormalized.values()];

	const observedUrls = (input.observedUrls ?? []).map((entry) => {
		const target = normalizeAbuseTarget(entry.target);
		if (target.targetType !== "domain" || !targetByNormalized.has(target.normalizedTarget)) {
			throw new AbuseInputError("Observed URLs must be associated with one of the submitted domain targets.");
		}
		const urls = entry.urls.map(normalizeObservedUrl);
		for (const url of urls) {
			const host = new URL(url).hostname;
			if (!domainMatchesOrIsSubdomain(host, target.normalizedTarget)) {
				throw new AbuseInputError(`Observed URL ${url} is not associated with submitted domain ${target.normalizedTarget}.`);
			}
		}
		const targetRow = targetByNormalized.get(target.normalizedTarget)!;
		for (const url of urls) if (!targetRow.observedUrls.includes(url)) targetRow.observedUrls.push(url);
		return { target: target.normalizedTarget, urls };
	});

	const evidence = await Promise.all((input.evidence ?? []).map(decodeEvidence));
	const evidenceBytes = evidence.reduce((total, item) => total + item.buffer.byteLength, 0);
	if (evidenceBytes > MAX_EVIDENCE_BYTES_PER_REPORT) {
		throw new AbuseInputError(`Evidence exceeds the ${MAX_EVIDENCE_BYTES_PER_REPORT / 1024 / 1024} MB report limit.`, 413);
	}

	const legalBrandUrl = normalizeLegalBrandUrl(input.legalBrandUrl);
	const normalizedForHash = {
		targets: targets.map(({ normalizedTarget, targetType, observedUrls: targetUrls }) => ({ normalizedTarget, targetType, observedUrls: targetUrls })),
		allegationCategory: input.allegationCategory,
		description: input.description,
		observedUrls,
		legalBrandUrl,
		reporterContactEmail: input.reporterContactEmail?.toLowerCase(),
		reporterIdentity: input.reporterIdentity ?? "service",
		evidence: evidence.map(({ filename, mimeType, sha256 }) => ({ filename, mimeType, sha256 })),
	};

	return {
		originalRequest: input,
		targets,
		allegationCategory: input.allegationCategory,
		description: input.description,
		observedUrls,
		legalBrandUrl,
		reporterContactEmail: input.reporterContactEmail?.toLowerCase(),
		reporterIdentity: input.reporterIdentity ?? "service",
		evidence,
		idempotencyKey: input.idempotencyKey,
		requestPayloadHash: hashStableJson(normalizedForHash),
	};
}

import { isIP } from "node:net";

import sharp from "sharp";
import { z } from "zod";

import type { AbuseTargetType } from "./schema";
import { AbuseInputError, hashStableJson, hostBelongsToTarget, normalizePublicHost, normalizePublicHttpUrl, sha256Hex } from "./security";

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
		reporterName: z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f<>]+$/, "must not contain control characters or angle brackets").optional(),
		reporterContactEmail: z.string().trim().email().max(320).optional(),
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
	targetType: AbuseTargetType;
	observedUrls: string[];
};

export type EvidenceMimeType = "image/jpeg" | "image/png" | "image/webp" | "message/rfc822" | "application/json";

export type DecodedEvidence = {
	filename: string;
	mimeType: EvidenceMimeType;
	buffer: Buffer;
	sha256: string;
};

export type ValidatedAbuseReportRequest = {
	/** The caller's request as received; retained verbatim as an artifact. */
	originalRequest: Record<string, unknown>;
	targets: NormalizedAbuseTarget[];
	allegationCategory: (typeof allegationCategories)[number];
	description: string;
	observedUrls: Array<{ target: string; urls: string[] }>;
	legalBrandUrl?: string;
	/**
	 * The public submitter, named only in the report text. Absent for
	 * submission-owned reports and API clients that send no identity: those
	 * reports are attributed to the service alone.
	 */
	reporter?: { name?: string; email?: string };
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
	const host = normalizePublicHost(original);
	if (!host) {
		throw new AbuseInputError(isIP(original.replace(/^\[(.*)\]$/, "$1"))
			? `Target ${original} is not a public routable IP address.`
			: `Target ${original} is not a public domain or IP address.`);
	}
	return { normalizedTarget: host, targetType: isIP(host) ? "ip" : "domain" };
}

export function normalizeObservedUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AbuseInputError(`Observed URL ${value} is invalid.`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new AbuseInputError("Observed URLs must use http or https.");
	if (url.username || url.password) throw new AbuseInputError("Observed URLs must not contain credentials.");
	const normalized = normalizePublicHttpUrl(value);
	if (!normalized) throw new AbuseInputError("Observed URL host must be a public domain or public IP address.");
	return normalized;
}

function normalizeLegalBrandUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = normalizePublicHttpUrl(value, { domainOnly: true });
	if (!normalized) throw new AbuseInputError("Legal brand URL must use http or https with a public domain and no credentials.");
	return normalized;
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

/** Decode untrusted image evidence and bind its MIME type to the decoded bytes. */
export async function decodeImageEvidence(item: z.infer<typeof evidenceSchema>): Promise<DecodedEvidence> {
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
		if (!targetByNormalized.has(target.normalizedTarget)) {
			throw new AbuseInputError("Observed URLs must be associated with one of the submitted targets.");
		}
		const urls = entry.urls.map(normalizeObservedUrl);
		for (const url of urls) {
			if (!hostBelongsToTarget(new URL(url).hostname, target.normalizedTarget)) {
				throw new AbuseInputError(`Observed URL ${url} is not associated with submitted target ${target.normalizedTarget}.`);
			}
		}
		const targetRow = targetByNormalized.get(target.normalizedTarget)!;
		for (const url of urls) if (!targetRow.observedUrls.includes(url)) targetRow.observedUrls.push(url);
		return { target: target.normalizedTarget, urls };
	});

	const evidence = await Promise.all((input.evidence ?? []).map(decodeImageEvidence));
	const evidenceBytes = evidence.reduce((total, item) => total + item.buffer.byteLength, 0);
	if (evidenceBytes > MAX_EVIDENCE_BYTES_PER_REPORT) {
		throw new AbuseInputError(`Evidence exceeds the ${MAX_EVIDENCE_BYTES_PER_REPORT / 1024 / 1024} MB report limit.`, 413);
	}

	const legalBrandUrl = normalizeLegalBrandUrl(input.legalBrandUrl);
	const reporter = input.reporterName || input.reporterContactEmail
		? { name: input.reporterName, email: input.reporterContactEmail?.toLowerCase() }
		: undefined;
	const normalizedForHash = {
		targets: targets.map(({ normalizedTarget, targetType, observedUrls: targetUrls }) => ({ normalizedTarget, targetType, observedUrls: targetUrls })),
		allegationCategory: input.allegationCategory,
		description: input.description,
		observedUrls,
		legalBrandUrl,
		reporter,
		evidence: evidence.map(({ filename, mimeType, sha256 }) => ({ filename, mimeType, sha256 })),
	};

	return {
		originalRequest: input,
		targets,
		allegationCategory: input.allegationCategory,
		description: input.description,
		observedUrls,
		legalBrandUrl,
		reporter,
		evidence,
		idempotencyKey: input.idempotencyKey,
		requestPayloadHash: hashStableJson(normalizedForHash),
	};
}

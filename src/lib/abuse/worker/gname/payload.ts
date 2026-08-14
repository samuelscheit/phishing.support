import { isSafeSkyvernStorageUrl } from "../../skyvern/storage";
import { recordValue } from "../shared";

export type GnameEvidenceSource = {
	id: string;
	name: string;
	mimeType: string;
	sha256: string;
	size: number;
};

export type GnameEvidenceUpload = {
	artifactId: string;
	sha256: string;
	state: "pending" | "upload_started" | "uploaded";
	startedAt?: string;
	presignedUrl?: string;
	uploadedAt?: string;
	expiresAt?: string;
};

export type GnameTaskInput = {
	entryUrl: string;
	description: string;
	domains: string[];
	observedUrls: string[];
	serviceName: string;
	legalBrandUrl: string;
	serviceMailbox: string;
	webhookUrl?: string;
	totpIdentifier?: string;
};

function stringArray(value: unknown, maximum: number): string[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 4_096)) {
		return undefined;
	}
	return [...value] as string[];
}

export function storedGnameTaskInput(providerPayload: Record<string, unknown>): GnameTaskInput | undefined {
	const input = recordValue(providerPayload.taskInput);
	if (!input
		|| typeof input.entryUrl !== "string"
		|| typeof input.description !== "string" || input.description.length > 1_000
		|| typeof input.serviceName !== "string" || input.serviceName.length === 0 || input.serviceName.length > 500
		|| typeof input.legalBrandUrl !== "string" || input.legalBrandUrl.length === 0 || input.legalBrandUrl.length > 4_096
		|| typeof input.serviceMailbox !== "string" || input.serviceMailbox.length === 0 || input.serviceMailbox.length > 320
		|| (input.webhookUrl !== undefined && typeof input.webhookUrl !== "string")
		|| (input.totpIdentifier !== undefined && typeof input.totpIdentifier !== "string")) {
		return undefined;
	}
	const domains = stringArray(input.domains, 100);
	const observedUrls = stringArray(input.observedUrls, 100);
	if (!domains || !observedUrls) return undefined;
	return {
		entryUrl: input.entryUrl,
		description: input.description,
		domains,
		observedUrls,
		serviceName: input.serviceName,
		legalBrandUrl: input.legalBrandUrl,
		serviceMailbox: input.serviceMailbox,
		webhookUrl: input.webhookUrl,
		totpIdentifier: input.totpIdentifier,
	};
}

export function storedGnameEvidenceSources(providerPayload: Record<string, unknown>): GnameEvidenceSource[] | undefined {
	if (!Array.isArray(providerPayload.sourceArtifacts) || providerPayload.sourceArtifacts.length === 0) return undefined;
	const sources: GnameEvidenceSource[] = [];
	for (const value of providerPayload.sourceArtifacts) {
		const source = recordValue(value);
		if (!source
			|| typeof source.id !== "string" || !/^\d+$/.test(source.id)
			|| typeof source.name !== "string" || source.name.length === 0 || source.name.length > 180
			|| (source.mimeType !== "image/jpeg" && source.mimeType !== "image/png")
			|| typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(source.sha256)
			|| typeof source.size !== "number" || !Number.isSafeInteger(source.size) || source.size <= 0) {
			return undefined;
		}
		sources.push({
			id: source.id,
			name: source.name,
			mimeType: source.mimeType,
			sha256: source.sha256.toLowerCase(),
			size: source.size,
		});
	}
	return new Set(sources.map((source) => source.id)).size === sources.length ? sources : undefined;
}

function validIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Every SDK file upload gets its own durable pre-call marker. A process that
 * dies after marking an upload started cannot know whether Skyvern accepted
 * it, so a later worker must fail closed rather than upload the same evidence
 * again. Completed URLs are intentionally bounded in age: a retry must never
 * silently substitute a fresh upload after a presigned URL may have expired.
 */
export function storedGnameEvidenceUploads(
	providerPayload: Record<string, unknown>,
	sources: GnameEvidenceSource[],
): GnameEvidenceUpload[] | undefined {
	if (!Array.isArray(providerPayload.evidenceUploads) || providerPayload.evidenceUploads.length !== sources.length) return undefined;
	const uploads: GnameEvidenceUpload[] = [];
	for (const [index, value] of providerPayload.evidenceUploads.entries()) {
		const candidate = recordValue(value);
		const source = sources[index];
		if (!candidate || !source
			|| candidate.artifactId !== source.id
			|| candidate.sha256 !== source.sha256
			|| !["pending", "upload_started", "uploaded"].includes(candidate.state as string)) {
			return undefined;
		}
		const state = candidate.state as GnameEvidenceUpload["state"];
		if (state === "pending") {
			if (candidate.startedAt !== undefined || candidate.presignedUrl !== undefined || candidate.uploadedAt !== undefined || candidate.expiresAt !== undefined) return undefined;
			uploads.push({ artifactId: source.id, sha256: source.sha256, state });
			continue;
		}
		if (state === "upload_started") {
			if (!validIsoTimestamp(candidate.startedAt) || candidate.presignedUrl !== undefined || candidate.uploadedAt !== undefined || candidate.expiresAt !== undefined) return undefined;
			uploads.push({ artifactId: source.id, sha256: source.sha256, state, startedAt: candidate.startedAt });
			continue;
		}
		if (typeof candidate.presignedUrl !== "string" || !isSafeSkyvernStorageUrl(candidate.presignedUrl)
			|| !validIsoTimestamp(candidate.uploadedAt) || !validIsoTimestamp(candidate.expiresAt)
			|| Date.parse(candidate.expiresAt) <= Date.parse(candidate.uploadedAt)) {
			return undefined;
		}
		uploads.push({
			artifactId: source.id,
			sha256: source.sha256,
			state,
			presignedUrl: candidate.presignedUrl,
			uploadedAt: candidate.uploadedAt,
			expiresAt: candidate.expiresAt,
		});
	}
	return uploads;
}

function queryParam(url: URL, name: string): string | undefined {
	for (const [key, value] of url.searchParams) if (key.toLowerCase() === name.toLowerCase()) return value;
	return undefined;
}

/**
 * Bounds a persisted upload URL without trusting URL query parameters to
 * extend its lifetime. `maximumAgeMs` is supplied by the caller so this
 * parser remains deterministic and independently testable.
 */
export function gnameEvidenceUploadDeadline(presignedUrl: string, uploadedAt: Date, maximumAgeMs: number): Date {
	const fallback = uploadedAt.getTime() + maximumAgeMs;
	let deadline = fallback;
	try {
		const url = new URL(presignedUrl);
		const expires = queryParam(url, "expires");
		if (expires && /^\d{10,13}$/.test(expires)) {
			const epoch = Number(expires) * (expires.length === 10 ? 1_000 : 1);
			if (Number.isSafeInteger(epoch)) deadline = Math.min(deadline, epoch);
		}
		const amzDate = queryParam(url, "x-amz-date");
		const amzExpires = queryParam(url, "x-amz-expires");
		const match = amzDate?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
		if (match && amzExpires && /^\d{1,8}$/.test(amzExpires)) {
			const signedAt = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
			const candidate = signedAt + Number(amzExpires) * 1_000;
			if (Number.isSafeInteger(candidate)) deadline = Math.min(deadline, candidate);
		}
	} catch {
		// The storage URL was validated before this helper. Retain the conservative
		// fallback in case a storage provider uses an opaque URL shape.
	}
	return new Date(deadline);
}

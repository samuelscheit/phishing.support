import type { AbuseArtifact } from "../schema";
import { sha256Hex } from "../security";
import { recordValue } from "../worker/shared";

export type ProviderEvidenceImageMimeType = "image/gif" | "image/jpeg" | "image/png" | "image/tiff";

export type ProviderEvidenceImageContract<MimeType extends ProviderEvidenceImageMimeType = ProviderEvidenceImageMimeType> = {
	acceptedMimeTypes: readonly MimeType[];
	maximumBytes: number;
	filenamePrefix: string;
};

export type ProviderEvidenceImageReference<MimeType extends ProviderEvidenceImageMimeType = ProviderEvidenceImageMimeType> = {
	artifactId: string;
	name: string;
	mimeType: MimeType;
	sha256: string;
	size: number;
	filename: string;
};

const extensions: Readonly<Record<ProviderEvidenceImageMimeType, string>> = {
	"image/gif": "gif",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/tiff": "tif",
};

function validContract<MimeType extends ProviderEvidenceImageMimeType>(
	contract: ProviderEvidenceImageContract<MimeType>,
): boolean {
	return contract.acceptedMimeTypes.length > 0
		&& contract.acceptedMimeTypes.every((mimeType) => mimeType in extensions)
		&& Number.isSafeInteger(contract.maximumBytes)
		&& contract.maximumBytes > 0
		&& /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(contract.filenamePrefix);
}

function assertContract<MimeType extends ProviderEvidenceImageMimeType>(
	contract: ProviderEvidenceImageContract<MimeType>,
): void {
	if (!validContract(contract)) throw new Error("Provider evidence-image contract is invalid.");
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
	return bytes.byteLength >= signature.length
		&& signature.every((byte, index) => bytes[index] === byte);
}

/** Verify the file's declared type against a provider-supported image signature. */
export function providerEvidenceImageHasExpectedMagic(
	bytes: Buffer,
	mimeType: ProviderEvidenceImageMimeType,
): boolean {
	if (!Buffer.isBuffer(bytes)) return false;
	switch (mimeType) {
		case "image/gif":
			return bytes.subarray(0, 6).toString("ascii") === "GIF87a"
				|| bytes.subarray(0, 6).toString("ascii") === "GIF89a";
		case "image/jpeg":
			return startsWith(bytes, [0xff, 0xd8, 0xff]);
		case "image/png":
			return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case "image/tiff":
			return startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])
				|| startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
	}
}

function generatedFilename(
	contract: ProviderEvidenceImageContract,
	artifactId: string,
	sha256: string,
	mimeType: ProviderEvidenceImageMimeType,
): string {
	return `${contract.filenamePrefix}_${artifactId}_${sha256.slice(0, 12)}.${extensions[mimeType]}`;
}

/** Validate original report evidence using its bytes, metadata, and immutable hash. */
export function isIntactProviderEvidenceImageArtifact<MimeType extends ProviderEvidenceImageMimeType>(
	artifact: Pick<AbuseArtifact, "kind" | "mimeType" | "sha256" | "size" | "blob">,
	contract: ProviderEvidenceImageContract<MimeType>,
): artifact is typeof artifact & { mimeType: MimeType } {
	assertContract(contract);
	if (artifact.kind !== "user_evidence_original"
		|| !contract.acceptedMimeTypes.includes(artifact.mimeType as MimeType)
		|| !Buffer.isBuffer(artifact.blob)
		|| artifact.blob.byteLength === 0
		|| artifact.blob.byteLength > contract.maximumBytes
		|| artifact.size !== artifact.blob.byteLength
		|| typeof artifact.sha256 !== "string"
		|| !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
		return false;
	}
	const mimeType = artifact.mimeType as MimeType;
	return providerEvidenceImageHasExpectedMagic(artifact.blob, mimeType)
		&& sha256Hex(artifact.blob) === artifact.sha256.toLowerCase();
}

/** Select one intact original image and persist only an immutable byte reference. */
export function selectProviderEvidenceImageArtifact<MimeType extends ProviderEvidenceImageMimeType>(
	artifacts: readonly AbuseArtifact[],
	contract: ProviderEvidenceImageContract<MimeType>,
): ProviderEvidenceImageReference<MimeType> | undefined {
	assertContract(contract);
	for (const artifact of artifacts) {
		if (!isIntactProviderEvidenceImageArtifact(artifact, contract)) continue;
		const artifactId = artifact.id.toString();
		const sha256 = artifact.sha256.toLowerCase();
		return {
			artifactId,
			name: artifact.name,
			mimeType: artifact.mimeType,
			sha256,
			size: artifact.size,
			filename: generatedFilename(contract, artifactId, sha256, artifact.mimeType),
		};
	}
	return undefined;
}

/** Read only an evidence reference previously built from the provider contract. */
export function storedProviderEvidenceImageReference<MimeType extends ProviderEvidenceImageMimeType>(
	value: unknown,
	contract: ProviderEvidenceImageContract<MimeType>,
): ProviderEvidenceImageReference<MimeType> | undefined {
	assertContract(contract);
	const reference = recordValue(value);
	if (!reference
		|| typeof reference.artifactId !== "string" || !/^\d+$/.test(reference.artifactId)
		|| typeof reference.name !== "string" || reference.name.length === 0 || reference.name.length > 255
		|| typeof reference.mimeType !== "string" || !contract.acceptedMimeTypes.includes(reference.mimeType as MimeType)
		|| typeof reference.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256)
		|| typeof reference.size !== "number" || !Number.isSafeInteger(reference.size) || reference.size <= 0 || reference.size > contract.maximumBytes
		|| typeof reference.filename !== "string"
		|| reference.filename !== generatedFilename(
			contract,
			reference.artifactId,
			reference.sha256,
			reference.mimeType as MimeType,
		)) {
		return undefined;
	}
	return reference as ProviderEvidenceImageReference<MimeType>;
}

/** Recheck persisted bytes immediately before they cross a provider boundary. */
export function providerEvidenceImageBytesMatch<MimeType extends ProviderEvidenceImageMimeType>(
	reference: ProviderEvidenceImageReference<MimeType>,
	bytes: Buffer,
	contract: ProviderEvidenceImageContract<MimeType>,
): boolean {
	return storedProviderEvidenceImageReference(reference, contract) !== undefined
		&& Buffer.isBuffer(bytes)
		&& bytes.byteLength === reference.size
		&& providerEvidenceImageHasExpectedMagic(bytes, reference.mimeType)
		&& sha256Hex(bytes) === reference.sha256;
}

/** Bind a loaded artifact to the exact immutable reference stored in the run. */
export function providerEvidenceImageArtifactMatches<MimeType extends ProviderEvidenceImageMimeType>(
	reference: ProviderEvidenceImageReference<MimeType>,
	artifact: Pick<AbuseArtifact, "id" | "name" | "kind" | "mimeType" | "sha256" | "size" | "blob">,
	contract: ProviderEvidenceImageContract<MimeType>,
): boolean {
	return isIntactProviderEvidenceImageArtifact(artifact, contract)
		&& artifact.id.toString() === reference.artifactId
		&& artifact.name === reference.name
		&& artifact.mimeType === reference.mimeType
		&& artifact.sha256.toLowerCase() === reference.sha256
		&& artifact.size === reference.size
		&& providerEvidenceImageBytesMatch(reference, artifact.blob, contract);
}

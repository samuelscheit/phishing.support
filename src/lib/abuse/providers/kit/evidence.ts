import { AbuseRepository } from "../../repository";
import type { BrowserFormFile } from "../browser_form";
import {
	providerEvidenceImageArtifactMatches,
	selectProviderEvidenceImageArtifact,
	type ProviderEvidenceImageContract,
	type ProviderEvidenceImageMimeType,
	type ProviderEvidenceImageReference,
} from "../evidence_image";
import type { AbuseArtifact } from "../../schema";

/** The provider's accepted screenshot types and size, with the prefix of the filenames we generate. */
export function evidenceContract<const M extends ProviderEvidenceImageMimeType>(
	filenamePrefix: string,
	evidence: { acceptedMimeTypes: readonly M[]; maximumBytes: number },
): ProviderEvidenceImageContract<M> {
	return { acceptedMimeTypes: evidence.acceptedMimeTypes, maximumBytes: evidence.maximumBytes, filenamePrefix };
}

/** The screenshot a draft references: kept from the stored draft when verifying, else selected from the report's artifacts. */
export function evidenceReferenceOf<M extends ProviderEvidenceImageMimeType>(
	contract: ProviderEvidenceImageContract<M>,
	artifacts: readonly AbuseArtifact[],
	stored?: { evidence: ProviderEvidenceImageReference<M> | null },
): ProviderEvidenceImageReference<M> | null {
	return stored ? stored.evidence : selectProviderEvidenceImageArtifact(artifacts, contract) ?? null;
}

/** Re-read the persisted bytes immediately before they cross the provider boundary; any change to the artifact stops the submission. */
export async function loadEvidenceFile<M extends ProviderEvidenceImageMimeType>(params: {
	reference: ProviderEvidenceImageReference<M>;
	contract: ProviderEvidenceImageContract<M>;
	reportId: bigint;
	/** The provider's name in the error. */
	label: string;
	getArtifact?: typeof AbuseRepository.getArtifact;
}): Promise<{ file: BrowserFormFile; bytes: Buffer }> {
	const artifact = await (params.getArtifact ?? AbuseRepository.getArtifact)(params.reportId, BigInt(params.reference.artifactId));
	if (!artifact || !providerEvidenceImageArtifactMatches(params.reference, artifact, params.contract)) {
		throw new Error(`The persisted ${params.label} evidence artifact no longer matches its immutable reference.`);
	}
	const bytes = Buffer.from(artifact.blob);
	return { file: { filename: params.reference.filename, mimeType: params.reference.mimeType, base64: bytes.toString("base64") }, bytes };
}

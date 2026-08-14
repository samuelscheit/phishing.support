import type { DecodedEvidence } from "../contracts";
import type { CapturedEvidence, EvidenceCapture, EvidenceDerivative } from "../evidence";

export type ServiceVerifier = (params: {
	url: string;
	screenshot: Buffer;
	pageText: string;
	pageTitle: string;
}) => Promise<{ phishing: boolean; confidence: number; rationale?: string }>;

type ServiceVerifierFetch = (input: URL, init?: RequestInit) => Promise<Response>;

export type ServiceVerifierDependencies = {
	/** Injectable only for deterministic endpoint-safety tests. */
	fetch?: ServiceVerifierFetch;
	/** Injectable only for deterministic endpoint-safety tests. */
	assertPublicHost?: (hostname: string) => Promise<void>;
};

export type GnameVerificationInput = {
	target: string;
	observedUrls: string[];
	legalBrandUrl?: string;
	description: string;
	userEvidence: DecodedEvidence[];
	serviceVerifier?: ServiceVerifier;
	capture?: EvidenceCapture;
};

export type GnameVerificationOutput = {
	passed: boolean;
	result: Record<string, unknown>;
	derivatives: EvidenceDerivative[];
	captures: CapturedEvidence[];
};

import type { DecodedEvidence } from "../../contracts";
import type { CapturedGnameEvidence, GnameEvidenceCapture, GnameEvidenceDerivative } from "./evidence";

export type GnameServiceVerifier = (params: {
	url: string;
	screenshot: Buffer;
	pageText: string;
	pageTitle: string;
}) => Promise<{ phishing: boolean; confidence: number; rationale?: string }>;

type GnameServiceVerifierFetch = (input: URL, init?: RequestInit) => Promise<Response>;

export type GnameServiceVerifierDependencies = {
	/** Injectable only for deterministic endpoint-safety tests. */
	fetch?: GnameServiceVerifierFetch;
	/** Injectable only for deterministic endpoint-safety tests. */
	assertPublicHost?: (hostname: string) => Promise<void>;
};

export type GnameVerificationInput = {
	target: string;
	observedUrls: string[];
	legalBrandUrl?: string;
	description: string;
	userEvidence: DecodedEvidence[];
	serviceVerifier?: GnameServiceVerifier;
	capture?: GnameEvidenceCapture;
};

export type GnameVerificationOutput = {
	passed: boolean;
	result: Record<string, unknown>;
	derivatives: GnameEvidenceDerivative[];
	captures: CapturedGnameEvidence[];
};

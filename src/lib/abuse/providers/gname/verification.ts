import { assertPublicDnsHost, domainMatchesOrIsSubdomain, normalizeDomain } from "../../security";
import { captureFreshGnameEvidence } from "./capture";
import { gnameServiceIdentity } from "./config";
import { GNAME_PROVIDER } from "./definition";
import { gnameDefinitionHasValidHash } from "./definition_integrity";
import { verifyGnameEvidence, type CapturedGnameEvidence } from "./evidence";
import { classifyGnameServiceEvidence } from "./service_verifier";
import type { GnameServiceVerifier, GnameVerificationInput, GnameVerificationOutput } from "./types";
import { publicGnameEvidenceHost } from "./url_policy";

/** Enforces every GNAME verification precondition before a portal job is queued. */
export async function verifyGnameRoute(input: GnameVerificationInput): Promise<GnameVerificationOutput> {
	const definition = GNAME_PROVIDER;
	if (!gnameDefinitionHasValidHash(definition)) throw new Error("GNAME provider definition is invalid.");
	const identity = gnameServiceIdentity();
	const capture = input.capture ?? captureFreshGnameEvidence;
	const captures: CapturedGnameEvidence[] = [];
	const captureReasons: string[] = [];
	const verifier: GnameServiceVerifier = input.serviceVerifier ?? classifyGnameServiceEvidence;
	const classificationResults: Array<Record<string, unknown>> = [];
	const contractReasons: string[] = [];
	if (input.legalBrandUrl) {
		try {
			const legalUrl = new URL(input.legalBrandUrl);
			if (legalUrl.protocol !== "https:" || legalUrl.username || legalUrl.password || legalUrl.port || !normalizeDomain(legalUrl.hostname)) {
				contractReasons.push("legal_brand_url_not_secure_public_https");
			} else {
				await assertPublicDnsHost(legalUrl.hostname);
			}
		} catch {
			contractReasons.push("legal_brand_url_unreachable_or_unsafe");
		}
	}

	for (const url of input.observedUrls) {
		let captured: CapturedGnameEvidence;
		try {
			captured = await capture(url);
		} catch {
			captureReasons.push("service_capture_failed");
			continue;
		}
		captures.push(captured);
		let finalHost: string | undefined;
		try {
			finalHost = publicGnameEvidenceHost(captured.url);
		} catch {
			captureReasons.push("capture_final_url_invalid");
		}
		if (!finalHost || !domainMatchesOrIsSubdomain(finalHost, normalizeDomain(input.target) ?? "")) {
			captureReasons.push("capture_redirected_to_unrelated_domain");
		}
		const pageText = captured.pageText ?? (typeof captured.metadata?.pageText === "string" ? captured.metadata.pageText : "");
		const pageTitle = captured.pageTitle ?? (typeof captured.metadata?.pageTitle === "string" ? captured.metadata.pageTitle : "");
		try {
			const classification = await verifier({ url: captured.url, screenshot: captured.screenshot, pageText, pageTitle });
			classificationResults.push({ url: captured.url, ...classification });
		} catch {
			captureReasons.push("service_verifier_failed");
		}
	}

	const strongestClassification = classificationResults.reduce(
		(best, current) => (Number(current.confidence ?? 0) > Number(best.confidence ?? 0) ? current : best),
		{ phishing: false, confidence: 0 },
	);
	const evidence = await verifyGnameEvidence({
		target: input.target,
		observedUrls: input.observedUrls,
		legalBrandUrl: input.legalBrandUrl,
		description: input.description,
		userEvidence: input.userEvidence,
		captures,
		captureFailures: captureReasons,
		classification: {
			phishing: strongestClassification.phishing === true,
			confidence: Number(strongestClassification.confidence ?? 0),
			rationale: typeof strongestClassification.rationale === "string" ? strongestClassification.rationale : undefined,
		},
	});
	const reasons = [...evidence.reasons, ...captureReasons, ...contractReasons];
	if (!identity.verified) reasons.push("verified_service_identity_required");
	if (input.target.includes(".") === false || !normalizeDomain(input.target)) reasons.push("domain_target_required");

	return {
		passed: reasons.length === 0,
		result: {
			provider: "gname",
			definitionVersion: definition.version,
			definitionHash: definition.contentHash,
			serviceIdentityVerified: identity.verified,
			classification: classificationResults,
			reasons: [...new Set(reasons)],
		},
		derivatives: evidence.derivatives,
		captures,
	};
}

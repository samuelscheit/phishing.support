import { isIP } from "node:net";

import { assertPublicDnsHost, isPublicIp, normalizeDomain } from "../security";
import type { ServiceVerifierDependencies } from "./types";

const MAX_SERVICE_VERIFIER_RESPONSE_BYTES = 64 * 1024;

function configuredServiceVerifierEndpoint(value: string): URL {
	let endpoint: URL;
	try {
		endpoint = new URL(value);
	} catch {
		throw new Error("Service verifier endpoint is invalid.");
	}
	if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || endpoint.hash) {
		throw new Error("Service verifier endpoint must be a credential-free public HTTPS URL without a custom port or fragment.");
	}
	const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
	if (isIP(hostname)) {
		if (!isPublicIp(hostname)) throw new Error("Service verifier endpoint must use a public network address.");
	} else {
		const normalized = normalizeDomain(hostname);
		if (!normalized) throw new Error("Service verifier endpoint must use a public DNS name.");
		endpoint.hostname = normalized;
	}
	return endpoint;
}

async function parseBoundedVerifierResponse(response: Response): Promise<Record<string, unknown>> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_SERVICE_VERIFIER_RESPONSE_BYTES) {
		throw new Error("Service verifier response exceeded its size limit.");
	}
	const body = Buffer.from(await response.arrayBuffer());
	if (body.byteLength > MAX_SERVICE_VERIFIER_RESPONSE_BYTES) {
		throw new Error("Service verifier response exceeded its size limit.");
	}
	let payload: unknown;
	try {
		payload = JSON.parse(body.toString("utf8"));
	} catch {
		throw new Error("Service verifier returned invalid JSON.");
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Service verifier returned an invalid response shape.");
	}
	return payload as Record<string, unknown>;
}

/**
 * Classify one fresh capture using an explicitly configured verifier. Its
 * endpoint is still a network boundary: validate the URL and DNS result,
 * forbid redirects, and bound the response before parsing it. This keeps a
 * deployment setting from becoming an exception to the service-wide SSRF
 * policy when the GNAME rollout gate is eventually enabled.
 */
export async function classifyConfiguredServiceEvidence(
	params: { url: string; screenshot: Buffer; pageText: string; pageTitle: string },
	dependencies: ServiceVerifierDependencies = {},
): Promise<{ phishing: boolean; confidence: number; rationale?: string }> {
	// Public enablement must be explicit. A missing verifier is a safe negative,
	// never an implicit approval based on the submitter's allegation.
	if (process.env.ABUSE_VERIFIER_ENABLED !== "true") return { phishing: false, confidence: 0, rationale: "Service verifier is not enabled." };
	const configuredEndpoint = process.env.ABUSE_VERIFIER_ENDPOINT?.trim();
	if (!configuredEndpoint) return { phishing: false, confidence: 0, rationale: "Service verifier endpoint is not configured." };
	const endpoint = configuredServiceVerifierEndpoint(configuredEndpoint);
	const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
	await (dependencies.assertPublicHost ?? assertPublicDnsHost)(hostname);
	const response = await (dependencies.fetch ?? fetch)(endpoint, {
		method: "POST",
		redirect: "manual",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ url: params.url, title: params.pageTitle, text: params.pageText.slice(0, 20_000), screenshotBase64: params.screenshot.toString("base64") }),
	});
	if (response.status >= 300 && response.status < 400) {
		throw new Error("Service verifier response redirected to an unapproved destination.");
	}
	if (!response.ok) throw new Error(`Service verifier returned HTTP ${response.status}.`);
	const payload = await parseBoundedVerifierResponse(response);
	const confidence = typeof payload.confidence === "number" && Number.isFinite(payload.confidence) && payload.confidence >= 0 && payload.confidence <= 1
		? payload.confidence
		: 0;
	return {
		phishing: payload.phishing === true && confidence > 0,
		confidence,
		rationale: typeof payload.rationale === "string" ? payload.rationale.slice(0, 2_000) : undefined,
	};
}

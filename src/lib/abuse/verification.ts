import fs from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium } from "patchright";
import sharp from "sharp";

import type { DecodedEvidence } from "./contracts";
import { verifyProviderEvidence, type CapturedEvidence } from "./evidence";
import { gnameServiceIdentity, getProviderDefinition, providerDefinitionHasValidHash } from "./registry";
import { assertPublicDnsHost, domainMatchesOrIsSubdomain, isPublicIp, normalizeDomain } from "./security";

const MAX_SERVICE_VERIFIER_RESPONSE_BYTES = 64 * 1024;

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
	capture?: (url: string) => Promise<CapturedEvidence>;
};

export type GnameVerificationOutput = {
	passed: boolean;
	result: Record<string, unknown>;
	derivatives: Array<{ name: string; mimeType: "image/jpeg" | "image/png"; buffer: Buffer; metadata: Record<string, unknown> }>;
	captures: CapturedEvidence[];
};

function publicTargetHost(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Evidence URL must use HTTP or HTTPS.");
	if (parsed.username || parsed.password || parsed.port) throw new Error("Evidence URL contains unsupported credentials or port.");
	return normalizeDomain(parsed.hostname) ?? (() => { throw new Error("Evidence URL host is not a public domain."); })();
}

/**
 * Capture a target in a fresh, throw-away Patchright profile. Every requested
 * hostname is DNS-checked before navigation; redirects to a different target
 * domain are recorded but never treated as evidence for the submitted domain.
 */
export async function captureFreshAbuseEvidence(url: string): Promise<CapturedEvidence> {
	const targetHost = publicTargetHost(url);
	await assertPublicDnsHost(targetHost);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "abuse-browser-"));
	const executablePath = process.env.CHROME_PATH;
	const context = await chromium.launchPersistentContext(profile, {
		...(executablePath ? { executablePath } : {}),
		headless: true,
		viewport: { width: 1440, height: 1000 },
		args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
	});
	try {
		const page = context.pages()[0] ?? (await context.newPage());
		await context.route("**/*", async (route) => {
			try {
				const requestUrl = new URL(route.request().url());
				if (!["http:", "https:"].includes(requestUrl.protocol)) {
					await route.abort();
					return;
				}
				await assertPublicDnsHost(requestUrl.hostname);
				await route.continue();
			} catch {
				await route.abort();
			}
		});
		await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
		const finalUrl = page.url();
		const finalHost = publicTargetHost(finalUrl);
		const screenshot = Buffer.from(await page.screenshot({ type: "png", fullPage: true }));
		const jpeg = await sharp(screenshot).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
		const pageTitle = (await page.title()).slice(0, 1_000);
		const pageText = (await page.locator("body").innerText().catch(() => "")).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 20_000);
		const associated = domainMatchesOrIsSubdomain(finalHost, targetHost);
		return {
			url: finalUrl,
			screenshot: jpeg,
			mimeType: "image/jpeg",
			capturedAt: new Date(),
			pageText,
			pageTitle,
			metadata: {
				initialUrl: url,
				initialHost: targetHost,
				finalHost,
				associated,
				pageTextLength: pageText.length,
			},
		};
	} finally {
		await context.close();
		await fs.rm(profile, { recursive: true, force: true });
	}
}

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

async function defaultServiceVerifier(params: { url: string; screenshot: Buffer; pageText: string; pageTitle: string }) {
	return classifyConfiguredServiceEvidence(params);
}

/** Enforces every GNAME verification precondition before a portal job is queued. */
export async function verifyGnameRoute(input: GnameVerificationInput): Promise<GnameVerificationOutput> {
	const definition = getProviderDefinition("gname");
	if (!definition || !providerDefinitionHasValidHash(definition)) throw new Error("GNAME provider definition is invalid.");
	const identity = gnameServiceIdentity();
	const capture = input.capture ?? captureFreshAbuseEvidence;
	const captures: CapturedEvidence[] = [];
	const captureReasons: string[] = [];
	const verifier = input.serviceVerifier ?? defaultServiceVerifier;
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
		let captured: CapturedEvidence;
		try {
			captured = await capture(url);
		} catch {
			captureReasons.push("service_capture_failed");
			continue;
		}
		captures.push(captured);
		let finalHost: string | undefined;
		try {
			finalHost = publicTargetHost(captured.url);
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
	const evidence = await verifyProviderEvidence({
		definition,
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

import { describe, expect, test } from "bun:test";

import type { AbuseArtifact } from "../../schema";
import { isIntactProviderEvidenceImageArtifact, selectProviderEvidenceImageArtifact } from "../kit/evidence";
import { providerDefinitionHasValidHash } from "../kit/pin";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { TENCENT_PROVIDER } from "./definition";
import {
	buildTencentSubmissionPayload,
	makeTencentExplanation,
	TENCENT_EVIDENCE_CONTRACT,
	storedTencentSubmissionPayload,
} from "./payload";
import type { TencentCapturedRequest, TencentFormInput, TencentFormSession } from "./browser";
import { buildTencentCloudHttpPayload, parseTencentCloudSubmissionResponse, prepareTencentExternalSubmission as rawPrepareTencentExternalSubmission, submitTencentSubmission, tencentCapturedRequestProblem, tencentDraft } from "./submission";
import { DESCRIPTION, verifiedPrepare } from "../kit/testing";
import { sha256Hex } from "../../../util/hash";

const prepareTencentExternalSubmission = verifiedPrepare(tencentDraft, rawPrepareTencentExternalSubmission);

const screenshotBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH1EAAAAASUVORK5CYII=", "base64");

function screenshotArtifact(overrides: Partial<AbuseArtifact> = {}): AbuseArtifact {
	return {
		id: 101n,
		reportId: 99n,
		targetId: 98n,
		routeId: null,
		runId: null,
		name: "website.png",
		kind: "user_evidence_original",
		mimeType: "image/png",
		sha256: sha256Hex(screenshotBytes),
		size: screenshotBytes.byteLength,
		metadata: { source: "test" },
		blob: screenshotBytes,
		createdAt: new Date(),
		...overrides,
	};
}

describe("Tencent Cloud abuse submission", () => {
	test("pins the reviewed provider definition", () => {
		expect(providerDefinitionHasValidHash(TENCENT_PROVIDER)).toBeTrue();
	});

	test("selects only an intact PNG screenshot and sends the provider-required form fields", () => {
		const screenshot = selectProviderEvidenceImageArtifact([screenshotArtifact()], TENCENT_EVIDENCE_CONTRACT);
		expect(screenshot).toBeDefined();
		if (!screenshot) throw new Error("expected screenshot");
		expect(isIntactProviderEvidenceImageArtifact(screenshotArtifact(), TENCENT_EVIDENCE_CONTRACT)).toBeTrue();
		expect(selectProviderEvidenceImageArtifact([screenshotArtifact({ mimeType: "image/jpeg" })], TENCENT_EVIDENCE_CONTRACT)).toBeUndefined();
		expect(selectProviderEvidenceImageArtifact([screenshotArtifact({ sha256: "0".repeat(64) })], TENCENT_EVIDENCE_CONTRACT)).toBeUndefined();
		const alteredBytes = Buffer.from(screenshotBytes);
		alteredBytes[0] = 0;
		expect(isIntactProviderEvidenceImageArtifact(screenshotArtifact({ blob: alteredBytes, size: alteredBytes.byteLength }), TENCENT_EVIDENCE_CONTRACT)).toBeFalse();

		const payload = buildTencentCloudHttpPayload({
			payload: {
				adapter: "tencent_cloud_dns_abuse_v1",
				definition: { version: TENCENT_PROVIDER.version, contentHash: TENCENT_PROVIDER.contentHash },
				target: {
					normalizedTarget: "login.phishing.example",
					observedUrl: "https://login.phishing.example/path",
					registrableDomain: "phishing.example",
				},
				report: { category: "Phishing", explanation: "Credential theft impersonating the bank.", legalBrandUrl: "https://bank.example/" },
				screenshot,
			},
			websiteScreenshot: screenshotBytes,
			captcha: { ret: 0, ticket: "ticket", randstr: "rand" },
		}) as { payload: { formData: Record<string, unknown> } };

		expect(payload.payload.formData).toMatchObject({
			domain: "phishing.example",
			category: ["Phishing"],
			privacyCheckbox1: true,
			privacyCheckbox2: true,
			infringedUrl: "https://bank.example/",
			fileBase64: screenshotBytes.toString("base64"),
		});
		expect(String(payload.payload.formData.filename)).toMatch(/^tencent_report_101_[a-f0-9]{12}\.png$/);
	});

	test("keeps the report explanation concise without invoking a draft generator", () => {
		const explanation = makeTencentExplanation({
			target: "phishing.example",
			observedUrl: "https://login.phishing.example/collect",
			description: `  ${"credential theft ".repeat(80)} `,
		});
		expect(explanation).toBeDefined();
		expect(explanation!.length).toBeLessThanOrEqual(400);
		expect(explanation).not.toContain("  ");
	});

	test("round-trips the pinned provider-specific narrative without regenerating it from its own output", () => {
		const screenshot = selectProviderEvidenceImageArtifact([screenshotArtifact()], TENCENT_EVIDENCE_CONTRACT);
		if (!screenshot) throw new Error("Expected an intact Tencent screenshot reference.");
		const payload = buildTencentSubmissionPayload({
			target: "phishing.example.com",
			observedUrl: "https://login.phishing.example.com/collect",
			description: "The captured page impersonates TikTok, captures login credentials, and requests payment details.",
			legalBrandUrl: "https://brand.example.com/",
			screenshot,
		});
		expect(payload).toBeDefined();
		expect(storedTencentSubmissionPayload(payload)).toEqual(payload);
	});

	test("treats only an explicit Tencent API rejection as provider-rejected", async () => {
		await expect(parseTencentCloudSubmissionResponse(new Response(JSON.stringify({ code: 1, msg: "rejected", data: { code: "7", error: "bad evidence" } })))).rejects
			.toBeInstanceOf(ProviderSubmissionRejectedError);
		await expect(parseTencentCloudSubmissionResponse(new Response("not json"))).rejects
			.toThrow("Tencent Cloud abuse report submission returned malformed JSON.");
		await expect(parseTencentCloudSubmissionResponse(new Response("upstream unavailable", { status: 502 }))).rejects
			.toThrow("Tencent Cloud abuse report submission failed with HTTP 502");
	});
});

function routeContext() {
	return async () => ({
		route: { id: 5n, routeType: "provider_submission", providerRegistryKey: "tencent", providerDefinitionVersion: TENCENT_PROVIDER.version, providerDefinitionHash: TENCENT_PROVIDER.contentHash },
		report: { id: 99n, submissionId: 1n, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/", description: DESCRIPTION },
		target: { normalizedTarget: "phish-site.com", targetType: "domain", observedUrls: ["https://phish-site.com/login"] },
		evidenceArtifacts: [screenshotArtifact()],
		targets: [],
	}) as never;
}

const CAPTCHA = { appid: "2070586963", ret: 0 as const, ticket: "t03tserver-ticket", randstr: "@abc" };

/** A browser page that records what it is told; its caught request is the one the real form would build. */
function fakeTencentForm(options: { captureError?: Error; tamper?: (body: Record<string, any>) => void; answer?: { status: number; text: string } } = {}) {
	const events: string[] = [];
	const inputs: TencentFormInput[] = [];
	const sent: TencentCapturedRequest[] = [];
	const session: TencentFormSession = {
		captureRequest: async (input) => {
			events.push("capture");
			inputs.push(input);
			if (options.captureError) throw options.captureError;
			const body = buildTencentCloudHttpPayload({
				payload: { target: { registrableDomain: input.domain, observedUrl: input.url, normalizedTarget: input.domain }, report: { category: input.category, explanation: input.describe, ...(input.infringedUrl ? { legalBrandUrl: input.infringedUrl } : {}) }, screenshot: { filename: input.screenshot.filename } } as never,
				websiteScreenshot: input.screenshot.bytes,
				captcha: { ...CAPTCHA },
			}) as Record<string, any>;
			options.tamper?.(body);
			return { url: `${TENCENT_PROVIDER.submissionUrl}?x=1`, method: "POST", contentType: "application/json", body: JSON.stringify(body) };
		},
		send: async (request) => {
			events.push("send");
			sent.push(request);
			return options.answer ?? { status: 200, text: JSON.stringify({ code: 0, msg: "success", data: { code: "0" } }) };
		},
		close: async () => { events.push("close"); },
	};
	return { session, events, inputs, sent, open: async () => session };
}

async function readyPayload() {
	const prepared = await tencentDraft.prepare({ routeId: 5n, payload: {} }, { loadRouteContext: routeContext() });
	expect(prepared).toMatchObject({ outcome: "ready" });
	return (prepared as { payload: Record<string, unknown> }).payload;
}

describe("Tencent Cloud browser filing", () => {
	test("fills the verified draft and catches the ticketed request before the marker; the one request follows it", async () => {
		const payload = await readyPayload();
		const form = fakeTencentForm();
		const context = { routeId: 5n, payload };
		const preflight = await prepareTencentExternalSubmission(context, { open: form.open, loadRouteContext: routeContext(), getArtifact: async () => screenshotArtifact() });
		expect(form.events).toEqual(["capture"]);
		expect(form.inputs[0]).toMatchObject({
			domain: "phish-site.com",
			url: "https://phish-site.com/login",
			infringedUrl: "https://www.examplebank.com/",
			category: "Phishing",
			name: "Phishing Support",
			countryName: "Germany",
		});
		expect(form.inputs[0]!.screenshot.bytes.equals(screenshotBytes)).toBeTrue();

		const success = await submitTencentSubmission(context, preflight);
		expect(form.events).toEqual(["capture", "send"]);
		expect(form.sent).toHaveLength(1);
		expect(JSON.parse(form.sent[0]!.body).payload.captcha).toEqual(CAPTCHA);
		expect(success).toMatchObject({ finalUrl: TENCENT_PROVIDER.reportPageUrl, submittedTargets: ["phish-site.com"], confirmationText: "success" });
		await preflight.dispose?.();
		expect(form.events).toEqual(["capture", "send", "close"]);
	});

	test("a failure before the marker closes the browser and sends nothing", async () => {
		const payload = await readyPayload();
		const deps = { loadRouteContext: routeContext(), getArtifact: async () => screenshotArtifact() };
		const failing = fakeTencentForm({ captureError: new Error("Tencent Cloud form could not be prepared: Tencent Cloud's slider was not solved (failed: tcaptcha: puzzle refused 3 times)") });
		await expect(prepareTencentExternalSubmission({ routeId: 5n, payload }, { ...deps, open: failing.open })).rejects.toThrow("slider was not solved");
		expect(failing.events).toEqual(["capture", "close"]);

		// A page whose request differs from the draft is not filed either.
		const tampered = fakeTencentForm({ tamper: (body) => { body.payload.formData.describe = "something else"; } });
		await expect(prepareTencentExternalSubmission({ routeId: 5n, payload }, { ...deps, open: tampered.open })).rejects.toThrow("differ from the verified draft");
		expect(tampered.events).toEqual(["capture", "close"]);
		const noTicket = fakeTencentForm({ tamper: (body) => { body.payload.captcha.ticket = ""; } });
		await expect(prepareTencentExternalSubmission({ routeId: 5n, payload }, { ...deps, open: noTicket.open })).rejects.toThrow("ticket is missing");
		expect([...failing.sent, ...tampered.sent, ...noTicket.sent]).toEqual([]);

		// A stored draft whose screenshot changed never opens a browser.
		let opened = 0;
		await expect(prepareTencentExternalSubmission({ routeId: 5n, payload }, { ...deps, getArtifact: async () => screenshotArtifact({ sha256: "0".repeat(64) }), open: async () => { opened++; return failing.session; } })).rejects.toThrow("no longer matches");
		expect(opened).toBe(0);
	});

	test("submit needs the prepared request, and classifies the answer: rejected is known, anything else ambiguous", async () => {
		await expect(submitTencentSubmission({ routeId: 5n, payload: {} }, { state: {} })).rejects.toThrow("requires its prepared draft");
		const payload = await readyPayload();
		const deps = { loadRouteContext: routeContext(), getArtifact: async () => screenshotArtifact() };
		const rejecting = fakeTencentForm({ answer: { status: 200, text: JSON.stringify({ code: 1, msg: "captcha ticket invalid", data: { code: "7" } }) } });
		const preflight = await prepareTencentExternalSubmission({ routeId: 5n, payload }, { ...deps, open: rejecting.open });
		await expect(submitTencentSubmission({ routeId: 5n, payload }, preflight)).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
		const waf = fakeTencentForm({ answer: { status: 502, text: "<html>bad gateway</html>" } });
		await expect(submitTencentSubmission({ routeId: 5n, payload }, await prepareTencentExternalSubmission({ routeId: 5n, payload }, { ...deps, open: waf.open }))).rejects.toThrow("HTTP 502");
	});

	test("recognises only the filing endpoint with a passed captcha as the request to send", () => {
		const draft = { target: { registrableDomain: "d.example", observedUrl: "https://d.example/", normalizedTarget: "d.example" }, report: { category: "Phishing", explanation: "x" }, screenshot: { filename: "e.png" } } as never;
		const body = JSON.stringify(buildTencentCloudHttpPayload({ payload: draft, websiteScreenshot: screenshotBytes, captcha: { ...CAPTCHA } }));
		const request = { url: `${TENCENT_PROVIDER.submissionUrl}?uin=1`, method: "POST", contentType: "application/json", body };
		expect(tencentCapturedRequestProblem(request, draft, screenshotBytes)).toBeUndefined();
		expect(tencentCapturedRequestProblem({ ...request, url: "https://evil.example/main/ajax/reportDsaPlatform/createDomainReport" }, draft, screenshotBytes)).toContain("evil.example");
		expect(tencentCapturedRequestProblem({ ...request, method: "GET" }, draft, screenshotBytes)).toContain("GET");
		expect(tencentCapturedRequestProblem({ ...request, body: "not json" }, draft, screenshotBytes)).toContain("ticket");
		expect(tencentCapturedRequestProblem({ ...request, body: body.replace('"ret":0', '"ret":1') }, draft, screenshotBytes)).toContain("ticket");
	});
});

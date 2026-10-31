import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import puppeteer from "rebrowser-puppeteer-core";

import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { contactRoute } from "../../resolver/routes";
import { providerDefinitionHasValidHash } from "../definition";
import { getProviderSubmissionProviderForMailbox } from "../submission_registry_default";
import { executeProviderSubmission } from "../submission_execution";
import type { ProviderSubmissionProvider } from "../submission_contracts";
import { GOOGLE_CLOUD_PROVIDER } from "./definition";
import {
	buildGoogleCloudSubmissionPayload,
	googleCloudAbuseDate,
	googleCloudServiceForTarget,
	storedGoogleCloudSubmissionPayload,
} from "./payload";
import { prepareGoogleCloudSubmission, readGoogleCloudSubmitResponse, submitGoogleCloudSubmission } from "./submission";

useTemporaryDatabase();

const capturedAt = new Date("2026-10-31T09:41:07.123Z");
const description = "The captured page impersonates Google and asks for an email or phone number to sign in, collecting login credentials.";

function payload(observedUrls = ["https://sites.google.com/view/revert-change"], target = "sites.google.com") {
	const value = buildGoogleCloudSubmissionPayload({ target, observedUrls, description, capturedAt, caseUrl: "https://phishing.support/submissions/374851334366564352" });
	if (!value) throw new Error("Expected a Google Cloud payload.");
	return value;
}

describe("Google Cloud abuse report payload", () => {
	test("owns exactly the two Google Cloud abuse mailboxes, which now route to the form", () => {
		expect(providerDefinitionHasValidHash(GOOGLE_CLOUD_PROVIDER)).toBeTrue();
		expect(GOOGLE_CLOUD_PROVIDER.exactMailboxes).toEqual(["network-abuse@google.com", "google-cloud-compliance@google.com"]);
		for (const mailbox of GOOGLE_CLOUD_PROVIDER.exactMailboxes) {
			expect(getProviderSubmissionProviderForMailbox(mailbox)?.definition.key).toBe("google_cloud");
			expect(contactRoute({ email: mailbox, providerName: "Google LLC", provenance: {}, snapshot: {} })).toMatchObject({
				routeType: "provider_submission",
				providerRegistryKey: "google_cloud",
				verifiedEmail: mailbox,
			});
		}
		// Google's RIPE contact for its IP space stays a plain email route.
		expect(contactRoute({ email: "ripe-contact@google.com", providerName: "Google LLC", provenance: {}, snapshot: {} }).routeType).toBe("email");
	});

	test("infers the Cloud product from the host, and leaves other Google hosts to Google's triage", () => {
		expect(googleCloudServiceForTarget("storage.googleapis.com")).toBe("cloud_storage");
		expect(googleCloudServiceForTarget("firebasestorage.googleapis.com")).toBe("cloud_storage");
		expect(googleCloudServiceForTarget("evil-project.appspot.com")).toBe("google_app_engine");
		expect(googleCloudServiceForTarget("20260101t000000-dot-evil.uc.r.appspot.com")).toBe("google_app_engine");
		expect(googleCloudServiceForTarget("34.102.117.75")).toBe("compute_engine");
		expect(googleCloudServiceForTarget("sites.google.com")).toBe("n_a");
		expect(googleCloudServiceForTarget("script.google.com")).toBe("n_a");
		// A lookalike that only ends in the same characters is not App Engine.
		expect(googleCloudServiceForTarget("notappspot.com")).toBe("n_a");
	});

	test("names the abusive URLs first, with the UTC time Google asks for, inside the 1,000-character field", () => {
		const durable = payload();
		expect(storedGoogleCloudSubmissionPayload(durable)).toEqual(durable);
		expect(durable.report).toMatchObject({ service: "n_a", abuseDate: "10/31/2026" });
		const details = durable.report.abuseDetails;
		expect(details.length).toBeLessThanOrEqual(1_000);
		expect(details).toContain("Abusive URLs:\n- https://sites.google.com/view/revert-change");
		expect(details).toContain("Observed: 2026-10-31T09:41:07Z (UTC).");
		expect(details).toContain("Evidence (screenshot, archived page, analysis): https://phishing.support/submissions/374851334366564352");
		expect(details).toContain("Google Cloud Acceptable Use Policy");
		expect(googleCloudAbuseDate(new Date("2026-01-05T23:59:59Z"))).toBe("01/05/2026");
	});

	test("keeps every URL when there are too many for the narrative, and never exceeds the field", () => {
		const urls = Array.from({ length: 30 }, (_, index) => `https://storage.googleapis.com/kit-bucket/login-${index}-${"x".repeat(20)}.html`);
		const durable = payload(urls, "storage.googleapis.com");
		expect(durable.report.service).toBe("cloud_storage");
		expect(durable.report.abuseDetails.length).toBeLessThanOrEqual(1_000);
		expect(durable.report.abuseDetails).toStartWith("Abusive URLs:\n- https://storage.googleapis.com/kit-bucket/login-0-");
	});

	test("drops URLs on other hosts and rejects a tampered draft", () => {
		expect(buildGoogleCloudSubmissionPayload({ target: "sites.google.com", observedUrls: ["https://evil.example/"], description, capturedAt })).toBeUndefined();
		const durable = payload();
		expect(storedGoogleCloudSubmissionPayload({ ...durable, report: { ...durable.report, service: "compute_engine" } })).toBeUndefined();
		expect(storedGoogleCloudSubmissionPayload({ ...durable, report: { ...durable.report, abuseDetails: "x".repeat(1_001) } })).toBeUndefined();
		expect(storedGoogleCloudSubmissionPayload({ ...durable, target: { ...durable.target, observedUrls: ["https://evil.example/"] } })).toBeUndefined();
	});

	test("only Google's explicit answer decides: a 4xx rejects, anything unreadable stays ambiguous", async () => {
		const response = (status: number, text: string) => ({ status: () => status, text: async () => text });
		await expect(readGoogleCloudSubmitResponse(response(200, `)]}'\n{"name":"cases/9-1234567890123"}`))).resolves.toEqual({ caseId: "9-1234567890123" });
		await expect(readGoogleCloudSubmitResponse(response(200, "{}"))).resolves.toEqual({});
		await expect(readGoogleCloudSubmitResponse(response(400, "bad request"))).rejects.toMatchObject({ name: "ProviderSubmissionRejectedError" });
		await expect(readGoogleCloudSubmitResponse(response(503, "unavailable"))).rejects.not.toMatchObject({ name: "ProviderSubmissionRejectedError" });
		await expect(readGoogleCloudSubmitResponse(response(200, "<html>"))).rejects.toThrow("unreadable response");
	});
});

const chromiumExecutable = process.env.PHISHING_TEST_CHROMIUM
	?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const chromiumAvailable = await Bun.file(chromiumExecutable).exists();

/** The fields, button, endpoint and confirmation of Google's form as captured on 2026-10-31. */
function googleCloudForm(answer: { status: number; body: string } | "never", captchaDelayMs = 300) {
	const posts: Array<Record<string, string>> = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/apis/cufinsert") {
				const body = await request.json() as { resource: { header: Array<{ name: string; value: string }> }; recaptcha_response_v3?: string };
				posts.push({ ...Object.fromEntries(body.resource.header.map(({ name, value }) => [name, value])), recaptcha: body.recaptcha_response_v3 ?? "" });
				if (answer === "never") return new Promise<Response>(() => undefined);
				return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json" } });
			}
			return new Response(`<!DOCTYPE html><html><body><form class="cf">
<input id="email_prefill_req" name="email_prefill_req" type="text">
${["n_a", "google_app_engine", "compute_engine", "cloud_storage"].map((value) => `<label><input type="radio" name="Google_Cloud_Platform_Service" id="Google_Cloud_Platform_Service--${value}" value="${value}">${value}</label>`).join("")}
<input id="abuse_date" name="abuse_date" placeholder="MM/DD/YYYY" type="text">
<textarea id="abuse_details" name="abuse_details" maxlength="1000"></textarea>
<div class="notification-area"></div>
<button class="submit-button" type="button">Submit</button>
<div class="confirmation-message__text" style="display:none">Thanks for your request. We'll only follow up with you if we need additional information.</div>
</form><script>
// The live form loads reCAPTCHA asynchronously and adds its token to the request.
setTimeout(() => { window.grecaptcha = { execute: async () => "recaptcha-token" }; }, ${captchaDelayMs});
document.querySelector(".submit-button").addEventListener("click", async () => {
	const field = (name) => document.querySelector("[name='" + name + "']" + (name === "Google_Cloud_Platform_Service" ? ":checked" : ""))?.value ?? "";
	const header = ["email_prefill_req", "Google_Cloud_Platform_Service", "abuse_date", "abuse_details"].map((name) => ({ name, value: field(name) }));
	const recaptcha_response_v3 = window.grecaptcha ? await window.grecaptcha.execute() : undefined;
	const response = await fetch("/apis/cufinsert?v=0", { method: "POST", body: JSON.stringify({ resource: { form_id: "cloud_platform_report", header }, recaptcha_response_v3 }) });
	if (response.ok) { document.querySelector(".confirmation-message__text").style.display = "block"; }
	else document.querySelector(".notification-area").textContent = "There were problems sending your form.";
});
</script></body></html>`, { headers: { "content-type": "text/html" } });
		},
	});
	return { server, posts, url: `http://127.0.0.1:${server.port}/code/contact/cloud_platform_report` };
}

async function googleCloudRoute() {
	const request = await validateAbuseReportRequest({
		targets: ["sites.google.com"],
		allegationCategory: "phishing",
		description,
		observedUrls: [{ target: "sites.google.com", urls: ["https://sites.google.com/view/revert-change"] }],
	});
	const created = await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } });
	const [target] = await AbuseRepository.listTargets(created.reportId);
	const route = await AbuseRepository.upsertResolvedRoute(target!.id, contactRoute({ email: "network-abuse@google.com", providerName: "Google LLC", provenance: {}, snapshot: {} }));
	return { created, route };
}

function browserProvider(form: { url: string }, timeouts?: { formReadyMs?: number; submitResponseMs?: number; confirmationMs?: number }): ProviderSubmissionProvider {
	return {
		definition: GOOGLE_CLOUD_PROVIDER,
		prepareSubmission: prepareGoogleCloudSubmission,
		submit: (context) => submitGoogleCloudSubmission(context, {
			reportPageUrl: form.url,
			...(timeouts ? { timeouts } : {}),
			openPage: async () => {
				const browser = await puppeteer.launch({ executablePath: chromiumExecutable, headless: true, args: ["--no-first-run"] });
				return { page: await browser.newPage(), close: () => browser.close() };
			},
		}),
	};
}

describe.skipIf(!chromiumAvailable)("Google Cloud abuse form, in a real browser", () => {
	test("fills the form from the durable draft and records Google's confirmation", async () => {
		const form = googleCloudForm({ status: 200, body: `)]}'\n{"name":"cases/9-1234567890123"}` });
		try {
			const { created, route } = await googleCloudRoute();
			await expect(executeProviderSubmission({ routeId: route.id, provider: browserProvider(form) })).resolves.toEqual({ outcome: "submitted", runId: expect.any(BigInt) });

			expect(form.posts).toHaveLength(1);
			const [sent] = form.posts;
			// The click waited for reCAPTCHA, so the request carries its token.
			expect(sent).toMatchObject({ email_prefill_req: "support@phishing.support", Google_Cloud_Platform_Service: "n_a", recaptcha: "recaptcha-token" });
			expect(sent!.abuse_date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
			expect(sent!.abuse_details).toContain("- https://sites.google.com/view/revert-change");
			const [run] = await AbuseRepository.listProviderRunsForReport(created.reportId);
			expect(run).toMatchObject({
				executionStatus: "completed",
				confirmationId: "9-1234567890123",
				confirmationText: expect.stringContaining("Thanks for your request"),
				submittedTargets: ["sites.google.com"],
			});
			expect((await AbuseRepository.getRoute(route.id))?.status).toBe("submitted");
		} finally {
			form.server.stop(true);
		}
	}, 60_000);

	test("a form whose reCAPTCHA never loads is never submitted", async () => {
		const form = googleCloudForm({ status: 200, body: "{}" }, 60_000);
		try {
			const { route } = await googleCloudRoute();
			const provider = browserProvider(form, { formReadyMs: 1_500 });
			await executeProviderSubmission({ routeId: route.id, provider }).catch(() => undefined);
			expect(form.posts).toHaveLength(0);
		} finally {
			form.server.stop(true);
		}
	}, 60_000);

	test("an explicit 4xx from the form is a rejection, never retried", async () => {
		const form = googleCloudForm({ status: 400, body: `{"error":"invalid"}` });
		try {
			const { route } = await googleCloudRoute();
			await expect(executeProviderSubmission({ routeId: route.id, provider: browserProvider(form) })).resolves.toMatchObject({ outcome: "provider_rejected" });
			expect(form.posts).toHaveLength(1);
			expect((await AbuseRepository.getRoute(route.id))?.status).toBe("provider_rejected");
		} finally {
			form.server.stop(true);
		}
	}, 60_000);

	test("no answer after the click is ambiguous: the route waits for a person instead of sending twice", async () => {
		const form = googleCloudForm("never");
		try {
			const { created, route } = await googleCloudRoute();
			const run = () => executeProviderSubmission({ routeId: route.id, provider: browserProvider(form, { submitResponseMs: 1_500 }) });
			await expect(run()).rejects.toMatchObject({ name: "ProviderSubmissionUnknownExternalStateError" });
			expect(form.posts).toHaveLength(1);
			const [stored] = await AbuseRepository.listProviderRunsForReport(created.reportId);
			expect(stored?.executionStatus).toBe("unknown_external_state");
			expect((await AbuseRepository.getRoute(route.id))?.status).toBe("unknown_external_state");
			// A second execution must not post again.
			await run().catch(() => undefined);
			expect(form.posts).toHaveLength(1);
		} finally {
			form.server.stop(true);
		}
	}, 60_000);
});

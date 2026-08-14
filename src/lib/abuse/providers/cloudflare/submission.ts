import type {
	ProviderSubmissionContext,
	ProviderSubmissionPreparation,
	ProviderSubmissionSuccess,
} from "../submission_contracts";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { getProviderProxy } from "../proxy";
import { recordValue, routeContext } from "../../worker/shared";

import { CLOUDFLARE_PROVIDER } from "./definition";
import { buildCloudflareFormPayload, type CloudflareFormPayload } from "./form";
import { cloudflareServiceIdentity } from "./identity";
import { solveCloudflareAbuseTurnstile } from "./turnstile";

const cloudflareUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

type CloudflareSubmissionPayload = {
	adapter: "cloudflare_abuse_phishing_v1";
	target: string;
	form: CloudflareFormPayload;
};

type CloudflareResponse = {
	ok(): boolean;
	status(): number;
	text(): Promise<string>;
};

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function parseStoredPayload(value: Record<string, unknown>): CloudflareSubmissionPayload | undefined {
	if (value.adapter !== "cloudflare_abuse_phishing_v1" || typeof value.target !== "string" || !value.target) return undefined;
	const form = recordValue(value.form);
	if (!form
		|| typeof form.name !== "string"
		|| typeof form.email !== "string"
		|| typeof form.emailConfirmation !== "string"
		|| typeof form.company !== "string"
		|| typeof form.urls !== "string"
		|| typeof form.justification !== "string"
		|| typeof form.originalWork !== "string"
		|| typeof form.reportedCountry !== "string"
		|| form.dsaAttestation !== true
		|| form.dsaCertification !== true) return undefined;
	try {
		new URL(form.urls);
		new URL(form.company);
	} catch {
		return undefined;
	}
	return { adapter: "cloudflare_abuse_phishing_v1", target: value.target, form: form as unknown as CloudflareFormPayload };
}

/** Build Cloudflare's immutable submission payload before its browser boundary. */
export async function prepareCloudflareSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionPreparation> {
	const { report, target } = await routeContext(context.routeId);
	if (report.allegationCategory !== "phishing") {
		throw new ProviderSubmissionRejectedError("Cloudflare's phishing form can only receive phishing allegations.");
	}
	if (target.targetType !== "domain") {
		return { outcome: "insufficient_evidence", reason: "cloudflare_phishing_form_requires_domain_target" };
	}
	const observedUrl = target.observedUrls[0];
	if (!observedUrl) return { outcome: "insufficient_evidence", reason: "cloudflare_phishing_form_requires_observed_url" };

	// Validate local configuration before the durable marker. It is deliberately
	// not embedded in the immutable payload because proxy credentials are secret.
	getProviderProxy("Cloudflare abuse reporting");
	const serviceIdentity = cloudflareServiceIdentity(report.requesterCountry);
	const form = buildCloudflareFormPayload({
		serviceIdentity,
		target: target.normalizedTarget,
		observedUrl,
		description: report.description,
		legalBrandUrl: report.legalBrandUrl ?? undefined,
	});
	return {
		outcome: "ready",
		payload: {
			adapter: "cloudflare_abuse_phishing_v1",
			target: target.normalizedTarget,
			form,
		},
	};
}

/** Interpret an explicit Cloudflare endpoint response after the form click. */
export async function parseCloudflareSubmissionResponse(response: CloudflareResponse, finalUrl: string, target: string): Promise<ProviderSubmissionSuccess> {
	const body = await response.text();
	if (!response.ok()) {
		if (response.status() >= 400 && response.status() < 500) {
			throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected with HTTP ${response.status()}: ${body.slice(0, 500)}`);
		}
		throw new Error(`Cloudflare abuse report submission failed with HTTP ${response.status()}: ${body.slice(0, 500)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("Cloudflare abuse report returned a successful HTTP status without a valid JSON confirmation.");
	}
	const json = recordValue(parsed);
	if (!json) throw new Error("Cloudflare abuse report returned an invalid confirmation response.");
	if (json.success === false || (Array.isArray(json.errors) && json.errors.length > 0)) {
		throw new ProviderSubmissionRejectedError(`Cloudflare abuse report was rejected: ${body.slice(0, 1_000)}`);
	}
	if (json.success !== true) {
		throw new Error("Cloudflare abuse report did not include an explicit success confirmation.");
	}

	return {
		confirmationId: stringField(json.id) ?? stringField(json.report_id) ?? stringField(json.case_id),
		confirmationText: stringField(json.message) ?? body.slice(0, 2_000),
		finalUrl,
		submittedTargets: [target],
	};
}

/** Submit one already-persisted Cloudflare form payload. */
export async function submitCloudflareSubmission(context: ProviderSubmissionContext): Promise<ProviderSubmissionSuccess> {
	const payload = parseStoredPayload(context.payload);
	if (!payload) throw new Error("The persisted Cloudflare provider payload is malformed.");

	const { page, browser } = await solveCloudflareAbuseTurnstile();
	try {
		const { form } = payload;
		await page.locator('[name="name"]').fill(form.name);
		await page.locator('[name="email"]').fill(form.email);
		await page.locator('[name="email2"]').fill(form.emailConfirmation);
		await page.locator('[name="company"]').fill(form.company);
		await page.locator('[name="urls"]').fill(form.urls);
		await page.locator('[name="justification"]').fill(form.justification);
		await page.locator('[name="original_work"]').fill(form.originalWork);
		await page.locator('[name="reported_country"]').evaluate((input, country) => {
			const field = input as HTMLInputElement;
			field.value = country;
			field.dispatchEvent(new Event("input", { bubbles: true }));
			field.dispatchEvent(new Event("change", { bubbles: true }));
		}, form.reportedCountry);
		await page.locator('[name="reported_user_agent"]').fill(cloudflareUserAgent);
		await page.locator('[name="dsa_attestation"]').check();

		const dsaCertification = page.locator(
			`xpath=//span[starts-with(normalize-space(.),"DSA certification")]` +
				`/ancestor::*[self::div][1]` +
				`//following::input[@type="checkbox"][1]`,
		);
		if ((await dsaCertification.count()) === 0) throw new Error("Failed to find Cloudflare DSA certification checkbox.");
		await dsaCertification.first().check();

		const responsePromise = page.waitForResponse((response) => response.url().includes(CLOUDFLARE_PROVIDER.responsePath));
		await page.locator('button[type="submit"]').click();
		const response = await responsePromise;
		return parseCloudflareSubmissionResponse(response, page.url(), payload.target);
	} finally {
		try {
			await browser.close();
		} catch (error) {
			// Browser cleanup does not change a known provider response. Do not
			// turn a confirmed submission into a duplicate-risk retry merely
			// because the local browser process exited noisily.
			console.warn("Cloudflare abuse browser cleanup failed:", error);
		}
	}
}

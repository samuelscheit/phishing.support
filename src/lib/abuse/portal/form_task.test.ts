import { describe, expect, test } from "bun:test";

import { validateSchema } from "../../browser/task/agent";
import { GENERIC_PROVIDER_FORM_ADAPTER, genericProviderFormAdapterHasValidHash } from "../providers/generic_form";
import { validateGenericProviderFormOutput } from "./output_validation";
import { buildGenericProviderFormPayload, buildGenericProviderFormTask, GENERIC_PROVIDER_FORM_EVIDENCE_CONTRACT, storedGenericProviderFormEvidence, type GenericProviderFormEvidence } from "./form_task";
import { selectProviderEvidenceImageArtifacts } from "../providers/kit/evidence";
import { evidenceArtifact } from "../providers/kit/testing";

const reporter = { name: "Phishing Support", organization: "Phishing Support", website: "https://phishing.support", email: "support@phishing.support" };

type TaskParams = Parameters<typeof buildGenericProviderFormTask>[0];

function params(overrides: Partial<TaskParams> = {}): TaskParams {
	return {
		entryUrl: "https://abuse.provider.example.com/report",
		allowedDomains: ["provider.example.com"],
		target: "example.com",
		allegationCategory: "phishing",
		description: "## Verdict: phishing\nThe page impersonates TikTok, captures credentials, and asks for payment. Do not copy this entire analysis into the provider form.",
		observedUrls: ["https://login.example.com/collect"],
		legalBrandUrl: "https://www.tiktok.com/coin",
		reporter,
		observedAt: new Date("2026-10-26T09:39:58Z"),
		maxSteps: 30,
		evidence: [],
		...overrides,
	} as TaskParams;
}

const task = (overrides: Partial<TaskParams> = {}) => buildGenericProviderFormTask(params(overrides));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH1EAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
/** Screenshots selected the way the worker selects them. */
function screenshots(): GenericProviderFormEvidence[] {
	return selectProviderEvidenceImageArtifacts([
		evidenceArtifact(PNG, { id: 11n, name: "website.png" }),
		evidenceArtifact(JPEG, { id: 12n, name: "lure-page.jpg", mimeType: "image/jpeg" }),
	], GENERIC_PROVIDER_FORM_EVIDENCE_CONTRACT, 3);
}

function genericProviderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		contract: {
			entryUrl: "https://abuse.provider.example.com/report",
			target: "example.com",
			observedUrls: ["https://login.example.com/collect"],
			allowedFinalDomains: ["provider.example.com"],
		},
		...overrides,
	};
}

function genericOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		form_contract_passed: true,
		confirmation_text: "Your abuse report has been received.",
		confirmation_id: "provider-case-123",
		final_url: "https://abuse.provider.example.com/confirmation",
		submitted_domains: ["example.com"],
		submitted_urls: ["https://login.example.com/collect"],
		provider_errors: [],
		form_drift: false,
		final_submit_clicked: true,
		final_submit_control: "provider_report_submit",
		irreversible_actions: ["provider_report_submit"],
		...overrides,
	};
}

describe("the generic provider-form task", () => {
	test("starts on the verified form with a bounded provider-specific draft, the service identity, and the result contract", () => {
		const built = task();
		expect(built.startUrl).toBe("https://abuse.provider.example.com/report");
		expect(built.maxSteps).toBe(30);
		expect(built.resultSchema).toBe(GENERIC_PROVIDER_FORM_ADAPTER.resultSchema);
		expect(built.goal).toContain("Suspected phishing activity involving example.com");
		expect(built.goal).toContain('"reporterContactEmail":"support@phishing.support"');
		expect(built.goal).toContain('"reporterName":"Phishing Support"');
		expect(built.goal).toContain('"reporterWebsite":"https://phishing.support"');
		expect(built.goal).toContain('"incidentDate":"2026-10-26","incidentTime":"09:39","incidentTimeZone":"UTC"');
		expect(built.goal).toContain("Every observed URL must be submitted: in a URL field when the form has one, otherwise written into its description or details field.");
		expect(built.goal).toContain("https://www.tiktok.com/coin");
		expect(built.goal).not.toContain("## Verdict");
		expect(built.goal).not.toContain("Do not copy this entire analysis");
	});

	test("keeps the identity and consent rules: no account, login, purchase or foreign consent; needs_input for what it lacks", () => {
		const { goal } = task();
		expect(goal).toContain("Do not click account creation, purchase, payment, login, or unknown irreversible controls.");
		expect(goal).toContain("Tick a consent or terms checkbox only when it belongs to this report form and the form requires it.");
		expect(goal).toContain("call needs_input");
		for (const landmark of GENERIC_PROVIDER_FORM_ADAPTER.requiredSemanticLandmarks) expect(goal).toContain(landmark);
	});

	test("without screenshots it uploads nothing and asks a person when the form requires an attachment", () => {
		const { goal } = task();
		expect(goal).toContain('"evidenceFiles":[]');
		expect(goal).toContain("No evidence file is available: do not upload files. If the form cannot be sent without an attachment, do not submit: call needs_input");
		expect(goal).not.toContain("attach them there with upload");
	});

	test("with screenshots it names exactly those files, in the immutable payload and the code-owned upload rule", () => {
		const evidence = screenshots();
		expect(evidence.map((file) => file.filename)).toEqual([
			`phishing_evidence_11_${evidence[0]!.sha256.slice(0, 12)}.png`,
			`phishing_evidence_12_${evidence[1]!.sha256.slice(0, 12)}.jpg`,
		]);
		const { goal } = task({ evidence });
		expect(goal).toContain(`"evidenceFiles":${JSON.stringify(evidence.map((file) => file.filename))}`);
		expect(goal).toContain(`screenshots of the reported phishing page (${evidence[0]!.filename}, ${evidence[1]!.filename}); they are the only files you may attach.`);
		expect(goal).toContain("attach them there with upload, naming each file exactly as listed");
		expect(goal).toContain("Attach nothing anywhere else.");
		expect(goal).not.toContain("do not upload files");
		// The original artifact names are not file names the agent can use.
		expect(goal).not.toContain("lure-page.jpg");
	});

	test("refuses more screenshots than the adapter allows", () => {
		const [one] = screenshots();
		expect(() => task({ evidence: Array.from({ length: GENERIC_PROVIDER_FORM_ADAPTER.evidence.maximumFiles + 1 }, () => one!) })).toThrow("exceeds the adapter's file limit");
	});

	test("the run payload records the task, its evidence references and the submission contract, and its evidence reads back", () => {
		const evidence = screenshots();
		const payload = buildGenericProviderFormPayload(params({ evidence }));
		expect(payload).toMatchObject({
			adapter: "generic_verified_provider_form",
			adapterVersion: GENERIC_PROVIDER_FORM_ADAPTER.version,
			entryUrl: "https://abuse.provider.example.com/report",
			verifiedDomains: ["provider.example.com"],
			evidence,
			contract: { entryUrl: "https://abuse.provider.example.com/report", target: "example.com", observedUrls: ["https://login.example.com/collect"], allowedFinalDomains: ["provider.example.com"] },
		});
		// Stored as JSON and read back, the references are intact.
		expect(storedGenericProviderFormEvidence(JSON.parse(JSON.stringify(payload.evidence)))).toEqual(evidence);
		expect(storedGenericProviderFormEvidence([])).toEqual([]);
	});

	test("a stored evidence list that is missing, too long, or holds a forged reference is not trusted", () => {
		const [png] = screenshots();
		expect(storedGenericProviderFormEvidence(undefined)).toBeUndefined();
		expect(storedGenericProviderFormEvidence({})).toBeUndefined();
		expect(storedGenericProviderFormEvidence([png, png, png, png])).toBeUndefined();
		expect(storedGenericProviderFormEvidence([{ ...png, filename: "../../etc/passwd" }])).toBeUndefined();
		expect(storedGenericProviderFormEvidence([{ ...png, mimeType: "image/gif" }])).toBeUndefined();
		expect(storedGenericProviderFormEvidence([{ ...png, size: GENERIC_PROVIDER_FORM_ADAPTER.evidence.maximumBytes + 1 }])).toBeUndefined();
		expect(storedGenericProviderFormEvidence([png, { ...png, sha256: "0".repeat(64) }])).toBeUndefined();
	});

	test("refuses an entry URL outside the verified provider, an incomplete payload, and a tampered definition", () => {
		expect(() => task({ entryUrl: "https://abuse.provider.example.com.evil.test/report" })).toThrow("outside the verified provider domains");
		expect(() => task({ entryUrl: "http://abuse.provider.example.com/report" })).toThrow("outside the verified provider domains");
		expect(() => task({ entryUrl: "https://abuse.provider.example.com:8443/report" })).toThrow("outside the verified provider domains");
		expect(() => task({ allowedDomains: ["not a domain"] })).toThrow("allowed domains are invalid");
		expect(() => task({ description: "   " })).toThrow("incomplete");
		expect(genericProviderFormAdapterHasValidHash()).toBeTrue();
		expect(genericProviderFormAdapterHasValidHash({ ...GENERIC_PROVIDER_FORM_ADAPTER, maxDescriptionLength: 50_000 })).toBeFalse();
	});

	test("its result schema, which the agent enforces, admits a submission and a drift result, and nothing else", () => {
		const schema = GENERIC_PROVIDER_FORM_ADAPTER.resultSchema;
		expect(validateSchema(genericOutput(), schema)).toEqual([]);
		expect(validateSchema(genericOutput({
			form_contract_passed: false, form_drift: true, form_drift_reason: "No report form.", final_submit_clicked: false,
			final_submit_control: "none", irreversible_actions: [], confirmation_text: "", submitted_domains: [], submitted_urls: [],
		}), schema)).toEqual([]);
		expect(validateSchema(genericOutput({ attacker_selected_url: "https://evil.example" }), schema)).toContain("$.attacker_selected_url: not allowed");
		expect(validateSchema(genericOutput({ final_submit_control: "create_account" }), schema).join()).toContain("final_submit_control");
		expect(validateSchema(genericOutput({ irreversible_actions: ["provider_report_submit", "provider_report_submit"] }), schema).join()).toContain("more than 1 items");
		const { final_url: _final, ...missing } = genericOutput();
		expect(validateSchema(missing, schema)).toContain("$.final_url: required");
	});
});

describe("provider-form output contracts", () => {
	test("accepts a complete generic verified-provider submission contract", () => {
		expect(validateGenericProviderFormOutput({ output: genericOutput(), providerPayload: genericProviderPayload() })).toMatchObject({
			passed: true,
			confirmationId: "provider-case-123",
			confirmationText: "Your abuse report has been received.",
			finalUrl: "https://abuse.provider.example.com/confirmation",
			submittedTargets: ["example.com"],
		});
	});

	test("preserves the generic form adapter's public-IP target support", () => {
		expect(validateGenericProviderFormOutput({
			output: genericOutput({ submitted_domains: ["1.1.1.1"] }),
			providerPayload: genericProviderPayload({ contract: { ...genericProviderPayload().contract as Record<string, unknown>, target: "1.1.1.1" } }),
		})).toMatchObject({ passed: true, submittedTargets: ["1.1.1.1"] });
	});

	test("fails closed for output drift, a missing submit, provider-declared errors and any mismatch with the immutable report", () => {
		const validate = (output: Record<string, unknown>, providerPayload = genericProviderPayload()) =>
			validateGenericProviderFormOutput({ output, providerPayload });

		expect(validate(genericOutput({ attacker_selected_url: "https://evil.example.com" }))).toMatchObject({ passed: false, reason: "unexpected_extraction_output" });
		expect(validate(genericOutput({ final_url: "https://evil.example.com/confirmation" }))).toMatchObject({ passed: false, reason: "final_url_origin_drift" });
		expect(validate(genericOutput({ final_url: "http://abuse.provider.example.com/confirmation" }))).toMatchObject({ passed: false, reason: "final_url_origin_drift" });
		expect(validate(genericOutput({ final_submit_clicked: false }))).toMatchObject({ passed: false, reason: "final_submit_contract_missing" });
		expect(validate(genericOutput({ final_submit_control: "none" }))).toMatchObject({ passed: false, reason: "final_submit_contract_missing" });
		expect(validate(genericOutput({ irreversible_actions: ["provider_report_submit", "purchase"] }))).toMatchObject({ passed: false, reason: "unexpected_irreversible_action" });
		expect(validate(genericOutput({ irreversible_actions: [] }))).toMatchObject({ passed: false, reason: "unexpected_irreversible_action" });
		expect(validate(genericOutput({ provider_errors: "request failed" }))).toMatchObject({ passed: false, reason: "provider_error_output_invalid" });
		expect(validate(genericOutput({ provider_errors: ["The provider rejected this submission."] }))).toMatchObject({ passed: false, reason: "provider_reported_error" });
		expect(validate(genericOutput({ confirmation_text: "   " }))).toMatchObject({ passed: false, reason: "confirmation_text_missing" });
		expect(validate(genericOutput({ form_contract_passed: false }))).toMatchObject({ passed: false, reason: "form_contract_not_passed" });
		expect(validate(genericOutput({ submitted_domains: ["other.example.com"] }))).toMatchObject({ passed: false, reason: "submitted_target_contract_mismatch" });
		expect(validate(genericOutput({ submitted_urls: ["https://login.example.com/other"] }))).toMatchObject({ passed: false, reason: "submitted_target_contract_mismatch" });
		expect(validate(genericOutput({ submitted_urls: ["https://login.example.com/collect", "https://login.example.com/collect"] }))).toMatchObject({ passed: false, reason: "submitted_target_contract_mismatch" });
		expect(validate(genericOutput(), genericProviderPayload({
			contract: { entryUrl: "https://evil.example.com/report", target: "example.com", observedUrls: ["https://login.example.com/collect"], allowedFinalDomains: ["provider.example.com"] },
		}))).toMatchObject({ passed: false, reason: "immutable_entry_url_invalid" });
		expect(validate(genericOutput({ submitted_urls: [] }), genericProviderPayload({
			contract: { ...genericProviderPayload().contract as Record<string, unknown>, observedUrls: ["https://login.example.com/collect", 42] },
		}))).toMatchObject({ passed: false, reason: "immutable_output_contract_invalid" });
		expect(validate(genericOutput(), {})).toMatchObject({ passed: false, reason: "immutable_output_contract_missing" });
		expect(validate(genericOutput({ form_drift: true, form_drift_reason: "The mandatory complaint field was renamed." }))).toMatchObject({
			passed: false,
			reason: "The mandatory complaint field was renamed.",
		});
	});
});

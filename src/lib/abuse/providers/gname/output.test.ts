import { describe, expect, test } from "bun:test";

import { GNAME_PROVIDER } from "./definition";
import { validateGnameSkyvernOutput } from "./output";

function gnameProviderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		contract: {
			entryUrl: GNAME_PROVIDER.entryUrl,
			providerDefinitionVersion: GNAME_PROVIDER.version,
			providerDefinitionHash: GNAME_PROVIDER.contentHash,
			domains: ["example.com"],
			observedUrls: ["https://login.example.com/collect"],
			allowedFinalDomains: GNAME_PROVIDER.verifiedDomains,
			declarationContract: "gname_service_declaration_v1",
		},
		...overrides,
	};
}

function gnameOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		form_contract_passed: true,
		confirmation_text: "Your abuse report has been received.",
		confirmation_id: "gname-case-123",
		final_url: "https://www.gname.com/abuse/confirmation",
		submitted_domains: ["example.com"],
		submitted_urls: ["https://login.example.com/collect"],
		provider_errors: [],
		form_drift: false,
		final_submit_clicked: true,
		final_submit_control: "provider_report_submit",
		declaration_checked: true,
		declaration_contract: "gname_service_declaration_v1",
		irreversible_actions: ["provider_report_submit"],
		...overrides,
	};
}

describe("GNAME Skyvern contract", () => {
	test("accepts a complete pinned GNAME submission contract", () => {
		expect(validateGnameSkyvernOutput({
			output: gnameOutput(),
			providerPayload: gnameProviderPayload(),
		})).toMatchObject({
			passed: true,
			confirmationId: "gname-case-123",
			finalUrl: "https://www.gname.com/abuse/confirmation",
			submittedTargets: ["example.com"],
		});
	});

	test("fails closed for the GNAME declaration and definition-pin drift", () => {
		const validate = (output: Record<string, unknown>, providerPayload = gnameProviderPayload()) =>
			validateGnameSkyvernOutput({ output, providerPayload });

		expect(validate(gnameOutput({ declaration_checked: false }))).toMatchObject({ passed: false, reason: "gname_declaration_contract_mismatch" });
		expect(validate(gnameOutput({ declaration_contract: "gname_service_declaration_v2" }))).toMatchObject({ passed: false, reason: "gname_declaration_contract_mismatch" });
		expect(validate(gnameOutput({ declaration_checked: undefined }))).toMatchObject({ passed: false, reason: "gname_declaration_contract_mismatch" });
		expect(validate(gnameOutput(), gnameProviderPayload({
			contract: {
				...gnameProviderPayload().contract as Record<string, unknown>,
				providerDefinitionVersion: "unreviewed-version",
			},
		}))).toMatchObject({ passed: false, reason: "provider_definition_pin_mismatch" });
		expect(validate(gnameOutput({ submitted_urls: [] }), gnameProviderPayload({
			contract: {
				...gnameProviderPayload().contract as Record<string, unknown>,
				observedUrls: [],
			},
		}))).toMatchObject({ passed: false, reason: "immutable_output_contract_invalid" });
		expect(validate(gnameOutput({ form_drift: true, form_drift_reason: "The declaration wording changed materially." }))).toMatchObject({
			passed: false,
			reason: "The declaration wording changed materially.",
		});
	});
});

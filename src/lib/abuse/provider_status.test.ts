import { describe, expect, test } from "bun:test";

import { describeProviderReportStatus } from "./provider_status";

describe("provider report lifecycle descriptions", () => {
	test("distinguishes verified, local preparation, submission, and confirmation", () => {
		expect(describeProviderReportStatus({ status: "verified" })).toBe(
			"The provider route is verified. The provider-specific report is queued; no request has been sent yet.",
		);
		expect(describeProviderReportStatus({ status: "running", executionStatus: "starting" })).toBe(
			"The provider-specific report is being prepared, including any required provider verification. No request has been sent yet.",
		);
		expect(describeProviderReportStatus({ status: "running", executionStatus: "submission_started" })).toBe(
			"The provider request has started. Provider receipt has not been confirmed yet.",
		);
		expect(describeProviderReportStatus({ status: "submitted" })).toBe(
			"The provider confirmed that it received this report.",
		);
	});

	test("explains ambiguous outcomes without implying a retry", () => {
		expect(describeProviderReportStatus({ status: "unknown_external_state" })).toContain(
			"was not retried automatically",
		);
		expect(describeProviderReportStatus({ status: "provider_rejected", error: "The provider explicitly rejected the URL." })).toBe(
			"The provider explicitly rejected the URL.",
		);
	});
});

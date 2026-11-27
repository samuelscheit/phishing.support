import { describe, expect, test } from "bun:test";

import { safePublicError } from "./security";

describe("the public text of a route's failure", () => {
	test("says a parked route stopped before sending, whatever the internal reason", () => {
		for (const detail of [
			"Cloudflare dashboard login failed: Cloudflare's Turnstile challenge issued no token within 120 s.",
			"provider_definition_pin_mismatch",
			"The persisted Cloudflare provider payload is malformed; review the draft before submitting.",
		]) {
			expect(safePublicError("needs_human", detail)).toBe("The automatic submission stopped before anything was sent to this provider; it needs a person to finish it.");
		}
	});

	test("a refusal before sending says what the provider's form requires, naming the provider", () => {
		const tucows = { key: "tucows", name: "Tucows" };
		expect(safePublicError("insufficient_evidence", "tucows_requires_a_brand_domain", tucows)).toBe("Tucows requires a brand domain.");
		expect(safePublicError("insufficient_evidence", "tucows_provider_definition_pin_mismatch", tucows)).toBe("Tucows provider definition pin mismatch.");
		expect(safePublicError("insufficient_evidence", "google_cloud_requires_an_observed_url", { key: "google_cloud", name: "Google Cloud" })).toBe("Google Cloud requires an observed URL.");
		expect(safePublicError("insufficient_evidence", "tencent_requires_a_valid_png_screenshot", { key: "tencent", name: "Tencent Cloud" })).toBe("Tencent Cloud requires a valid PNG screenshot.");
		// Another provider's prefix, or none known, is read as it is.
		expect(safePublicError("insufficient_evidence", "discord_dsa_requires_the_webhook_server_id", { key: "discord_webhook", name: "Discord" })).toBe("Discord DSA requires the webhook server ID.");
		expect(safePublicError("insufficient_evidence", "netcraft_mail_message_exceeds_20_mib", { key: null, name: "Netcraft" })).toBe("Netcraft mail message exceeds 20 MiB.");
		expect(safePublicError("insufficient_evidence", "Evidence image too large.\nRetry")).toBe("Evidence image too large. Retry");
		expect(safePublicError("insufficient_evidence", null)).toBeUndefined();
	});

	test("never shows internal detail, only a provider's own rejection", () => {
		expect(safePublicError("failed", "token=SECRET")).toBe("The provider route did not complete safely.");
		expect(safePublicError("provider_rejected", "  Not   our\n network  ")).toBe("Not our network");
		expect(safePublicError("provider_rejected", "x".repeat(600))).toHaveLength(500);
		expect(safePublicError("submitted", "anything")).toBeUndefined();
		expect(safePublicError("needs_human", undefined)).toBeUndefined();
		expect(safePublicError("needs_human", "")).toBeUndefined();
	});
});

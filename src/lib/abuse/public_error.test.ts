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

	test("never shows internal detail, only a provider's own rejection", () => {
		expect(safePublicError("failed", "token=SECRET")).toBe("The provider route did not complete safely.");
		expect(safePublicError("provider_rejected", "  Not   our\n network  ")).toBe("Not our network");
		expect(safePublicError("provider_rejected", "x".repeat(600))).toHaveLength(500);
		expect(safePublicError("submitted", "anything")).toBeUndefined();
		expect(safePublicError("needs_human", undefined)).toBeUndefined();
		expect(safePublicError("needs_human", "")).toBeUndefined();
	});
});

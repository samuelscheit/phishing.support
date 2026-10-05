import { describe, expect, test } from "bun:test";

import { GNAME_PROVIDER } from "./definition";
import { buildGnameTaskPayload, type GnameTaskPayloadInput } from "./task";

function gnameTaskInput(overrides: Partial<GnameTaskPayloadInput> = {}): GnameTaskPayloadInput {
	return {
		entryUrl: GNAME_PROVIDER.entryUrl,
		description: "Credential-harvesting page targeting the protected brand.",
		domains: ["example.com"],
		observedUrls: ["https://login.example.com/collect"],
		serviceName: "Phishing Support",
		legalBrandUrl: "https://brand.example.com/",
		serviceMailbox: "gname-reports@phishing.support",
		presignedEvidenceUrls: ["https://storage.example.com/immutable-evidence"],
		...overrides,
	};
}

describe("GNAME Skyvern task", () => {
	test("builds only the reviewed task from validated immutable input", () => {
		const payload = buildGnameTaskPayload(gnameTaskInput());
		expect(payload).toMatchObject({
			url: GNAME_PROVIDER.entryUrl,
			data_extraction_schema: GNAME_PROVIDER.extractionSchema,
			totp_identifier: undefined,
			engine: "skyvern-2.0",
			include_action_history_in_verification: true,
		});
		expect(payload.prompt).toContain("pinned GNAME category-2 abuse form");
		expect(payload.prompt).toContain("gname-reports@phishing.support");
	});

	test("fails before task creation when a pinned input boundary drifts", () => {
		expect(() => buildGnameTaskPayload(gnameTaskInput({ entryUrl: "https://www.gname.com/other" }))).toThrow("pinned provider URL");
		expect(() => buildGnameTaskPayload(gnameTaskInput({ domains: ["203.0.113.10"] }))).toThrow("domains are missing or invalid");
		expect(() => buildGnameTaskPayload(gnameTaskInput({ presignedEvidenceUrls: ["https://127.0.0.1/evidence"] }))).toThrow("evidence URLs are missing or unsafe");
	});
});

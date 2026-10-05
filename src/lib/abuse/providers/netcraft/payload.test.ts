import { describe, expect, test } from "bun:test";

import { providerDefinitionHasValidHash } from "../definition";
import { NETCRAFT_PROVIDER } from "./definition";
import {
	buildNetcraftReportUrlsBody,
	buildNetcraftSubmissionPayload,
	makeNetcraftReason,
	storedNetcraftSubmissionPayload,
} from "./payload";

describe("Netcraft submission payload", () => {
	test("pins the reviewed supplemental API definition", () => {
		expect(NETCRAFT_PROVIDER.supplemental).toBeTrue();
		expect(NETCRAFT_PROVIDER.exactMailboxes).toEqual([]);
		expect(NETCRAFT_PROVIDER.supplementalTargets).toEqual([{ targetType: "domain", requiresObservedUrl: true }]);
		expect(providerDefinitionHasValidHash(NETCRAFT_PROVIDER)).toBeTrue();
	});

	test("preserves every normalized observed URL in one documented v3 request", () => {
		const payload = buildNetcraftSubmissionPayload({
			target: "phishing.example.com",
			observedUrls: [
				"https://login.phishing.example.com/collect#discarded",
				"https://phishing.example.com/alternate",
			],
			description: "The target hosts a credential-harvesting page impersonating the protected brand.",
			legalBrandUrl: "https://brand.example.com/legitimate-service",
			reporterEmail: " Netcraft-Reports@Phishing.Support ",
		});

		expect(payload).toMatchObject({
			adapter: "netcraft_report_urls_v3",
			target: {
				normalizedTarget: "phishing.example.com",
				observedUrls: [
					"https://login.phishing.example.com/collect",
					"https://phishing.example.com/alternate",
				],
			},
			report: {
				reporterEmail: "netcraft-reports@phishing.support",
			},
		});
		if (!payload) throw new Error("Expected a Netcraft payload.");
		expect(payload.report.reason).toContain("Impersonated brand: https://brand.example.com/legitimate-service");
		expect(buildNetcraftReportUrlsBody(payload)).toEqual({
			email: "netcraft-reports@phishing.support",
			reason: payload.report.reason,
			urls: [
				{ url: "https://login.phishing.example.com/collect" },
				{ url: "https://phishing.example.com/alternate" },
			],
		});
		expect(storedNetcraftSubmissionPayload(payload)).toEqual(payload);
	});

	test("bounds the API reason and refuses URL or reporter identity drift", () => {
		const reason = makeNetcraftReason({
			description: ("credential theft on an impersonating page ").repeat(400),
			legalBrandUrl: "https://brand.example.com/",
		});
		expect(reason).toBeDefined();
		expect(reason!.length).toBeLessThanOrEqual(NETCRAFT_PROVIDER.maximumReasonLength);

		expect(buildNetcraftSubmissionPayload({
			target: "phishing.example.com",
			observedUrls: ["https://unrelated.example.com/collect"],
			description: "Credential theft.",
			reporterEmail: "reports@phishing.support",
		})).toBeUndefined();
		expect(buildNetcraftSubmissionPayload({
			target: "phishing.example.com",
			observedUrls: ["https://phishing.example.com/collect"],
			description: "Credential theft.",
			reporterEmail: "not a mailbox",
		})).toBeUndefined();
	});
});

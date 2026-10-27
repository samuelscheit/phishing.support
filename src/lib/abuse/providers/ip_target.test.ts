import { describe, expect, test } from "bun:test";

import { buildGoogleSafeBrowsingSubmissionPayload } from "./google_safe_browsing/payload";
import { buildNetcraftSubmissionPayload } from "./netcraft/payload";
import { listSupplementalProviderSubmissionProvidersForTarget } from "./submission_registry_default";
import { createAbuseEmailDraft } from "../mail/draft";

const target = "85.215.226.225";
const observedUrls = ["https://85.215.226.225/Netflix/Home/login.php", "http://85.215.226.225/Netflix/Home/login.php"];
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";

describe("IP-hosted phishing sites", () => {
	test("receive the URL-based supplemental providers, but only with observed URLs", () => {
		expect(listSupplementalProviderSubmissionProvidersForTarget({ targetType: "ip", observedUrls }).map((provider) => provider.definition.key).sort())
			.toEqual(["google_safe_browsing", "netcraft"]);
		expect(listSupplementalProviderSubmissionProvidersForTarget({ targetType: "ip", observedUrls: [] })).toEqual([]);
	});

	test("build Netcraft and Google Safe Browsing payloads bound to the exact address", () => {
		expect(buildNetcraftSubmissionPayload({ target, observedUrls, description, reporterEmail: "report@phishing.support" })?.target)
			.toEqual({ normalizedTarget: target, observedUrls });
		expect(buildNetcraftSubmissionPayload({ target, observedUrls: ["https://85.215.226.226/"], description, reporterEmail: "report@phishing.support" })).toBeUndefined();
		expect(buildGoogleSafeBrowsingSubmissionPayload({ target, observedUrl: observedUrls[0]!, description })?.target)
			.toEqual({ normalizedTarget: target, observedUrl: observedUrls[0] });
	});

	test("list their URLs in the abuse email to the network operator", async () => {
		const draft = await createAbuseEmailDraft({
			route: { routeType: "email", verifiedEmail: "abuse@ionos.com" },
			recipient: "abuse@ionos.com",
			report: { allegationCategory: "phishing", description, submissionId: 373426928255766528n, reporterName: null, reporterContactEmail: null, legalBrandUrl: null },
			target: { normalizedTarget: target, observedUrls },
		} as never, { generateSummary: async () => undefined });
		for (const url of observedUrls) expect(draft.body).toContain(url);
	});
});

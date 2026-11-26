import { describe, expect, test } from "bun:test";

import { submissionStatusLabel } from "@/components/SubmissionStatus";
import type { SubmissionData } from "@/lib/db/schema";
import type { WebsiteRoute, WebsiteSiteFinding } from "@/lib/website/types";
import { caseFinding, caseReportedAs, reportedAsOf } from "./finding";

const route = (...findings: WebsiteSiteFinding[]): WebsiteRoute => ({
	hops: findings.map((_, index) => ({ index, url: `https://s${index}.example/`, hostname: `s${index}.example`, status: 200, contentCaptured: true })),
	analyzedHopIndex: 0,
	siteAssessments: findings.map((finding, hopIndex) => ({ hopIndex, finding })),
});
const website = (routes: WebsiteRoute[], analyzedRoute?: number): SubmissionData => ({ kind: "website", website: { url: "https://s0.example/", routes, analyzedRoute } });
const FUNNEL = { verdict: { finding: "deceptive_funnel" }, extraction: {} } as never;

describe("what a reported case was reported for", () => {
	test("its confirmed sites on any route decide: phishing, malware, or both", () => {
		expect(caseReportedAs(website([route("phishing")]))).toBe("phishing");
		// Production case 384401854580134038: a copy button handing out a payload is malware.
		expect(caseReportedAs(website([route("benign"), route("malware")]))).toBe("malware");
		expect(caseReportedAs(website([route("insufficient_evidence", "phishing"), route("malware")]))).toBe("phishing_and_malware");
	});

	test("a deceptive funnel names it only when no site of the case was confirmed", () => {
		expect(caseReportedAs(website([{ ...route("insufficient_evidence"), funnel: FUNNEL }]))).toBe("deceptive_funnel");
		expect(caseReportedAs(website([{ ...route("malware"), funnel: FUNNEL }]))).toBe("malware");
	});

	test("an email is reported as phishing; a case without kept verdicts has no label of its own", () => {
		expect(caseReportedAs({ kind: "email" })).toBe("phishing");
		expect(caseReportedAs(website([]))).toBeUndefined();
		expect(caseReportedAs({ kind: "website", website: { url: "https://legacy.example/" } })).toBeUndefined();
		expect(reportedAsOf("website", { phishing: false, malware: false, deceptiveFunnel: false })).toBeUndefined();
		expect(reportedAsOf("email", { phishing: false, malware: false, deceptiveFunnel: false })).toBe("phishing");
	});
});

describe("caseFinding", () => {
	test("is the verdict of the analyzed route's analyzed page, not of another route or hop", () => {
		const second = { ...route("insufficient_evidence", "malware"), analyzedHopIndex: 1 };
		expect(caseFinding(website([route("benign"), second], 1))).toBe("malware");
		expect(caseFinding(website([route("benign"), second]))).toBe("benign");
		expect(caseFinding(website([{ ...route("benign"), analyzedHopIndex: undefined }]))).toBeUndefined();
		expect(caseFinding({ kind: "email" })).toBeUndefined();
	});
});

describe("the status badge", () => {
	test("labels a reported case by what it was reported for and a case without a threat as such", () => {
		expect(submissionStatusLabel("reported", "phishing")).toBe("Phishing");
		expect(submissionStatusLabel("reported", "malware")).toBe("Malware");
		expect(submissionStatusLabel("reported", "phishing_and_malware")).toBe("Phishing & malware");
		expect(submissionStatusLabel("reported", "deceptive_funnel")).toBe("Deceptive funnel");
		expect(submissionStatusLabel("reported")).toBe("Reported");
		// Nothing reportable covers malware too: never "Not phishing".
		expect(submissionStatusLabel("invalid")).toBe("No threat found");
		expect(submissionStatusLabel("invalid", "malware")).toBe("No threat found");
		expect(submissionStatusLabel("failed")).toBe("failed");
		expect(submissionStatusLabel(" running ")).toBe("running");
		expect(submissionStatusLabel(undefined)).toBe("Unknown");
	});
});

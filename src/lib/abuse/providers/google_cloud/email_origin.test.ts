import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../../../db/entities/submissions";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { contactRoute } from "../../resolver/routes";
import { reportConfirmedEmailPhishing } from "../../submission_reports";
import { emailOriginOf, parseEmailOrigin, receivedHopOf } from "../email_origin";
import { buildGoogleCloudSubmissionPayload, storedGoogleCloudSubmissionPayload } from "./payload";
import { prepareGoogleCloudSubmission } from "./submission";

useTemporaryDatabase();

const IP = "35.237.61.31";
const LINK = "https://storage.googleapis.com/tyhfghwsdfvgqgfqghsd/lis";
const CASE = "https://phishing.support/submissions/382165893943136282";
const RECEIVED_OLD = "Received: from relay.internal (relay.internal [10.0.0.4])\r\n\tby mx.example.net with ESMTP id abc; Thu, 19 Nov 2026 10:00:03 +0000";
const RECEIVED_HOP = `Received: from mail.sender.example (mail.sender.example [${IP}])\r\n\tby mx.example.net (Postfix) with ESMTPS id 4F1;\r\n\tThu, 19 Nov 2026 10:00:01 +0100 (CET)`;
const eml = [
	RECEIVED_OLD,
	RECEIVED_HOP,
	"From: Antivirus Billing <billing@sender.example>",
	"To: [redacted] <[redacted]>",
	"Subject: Your payment was declined",
	"MIME-Version: 1.0",
	"Content-Type: multipart/alternative; boundary=b",
	"",
	"--b",
	"Content-Type: text/plain; charset=utf-8",
	"",
	`Renew now: ${LINK}. Unsubscribe: https://tracker.example.org/u?id=1`,
	"--b",
	"Content-Type: text/html; charset=utf-8",
	"",
	`<p><a href="${LINK}">Renew</a> <a href="${LINK}">again</a> <img src="https://img.example.org/p.png"></p>`,
	"--b--",
	"",
].join("\r\n");
const analysis = [
	"- **Claimed brand:** None clearly stated. “Memory Bank,” “Security Billing Center,” and “Privacy Protection Pro” are generic/inconsistent names—not a real, identified antivirus vendor.",
	"- The email asks for a payment to renew an antivirus subscription and links to a page collecting card details.",
].join("\n");
const capturedAt = new Date("2026-11-20T08:00:00.000Z");

describe("the sending hop of a phishing email", () => {
	test("is the Received header that names the IP, with its time in UTC", () => {
		const hop = receivedHopOf([RECEIVED_OLD, RECEIVED_HOP], IP);
		expect(hop?.at.toISOString()).toBe("2026-11-19T09:00:01.000Z");
		expect(hop?.line).toStartWith(`from mail.sender.example (mail.sender.example [${IP}]) by mx.example.net`);
		expect(hop?.line).not.toContain("\n");
	});

	test("never matches a longer address that merely contains the IP, or a header without a time", () => {
		expect(receivedHopOf([`from a ([135.237.61.31]) by b; Thu, 19 Nov 2026 10:00:01 +0000`], IP)).toBeUndefined();
		expect(receivedHopOf([`from a ([${IP}0]) by b; Thu, 19 Nov 2026 10:00:01 +0000`], IP)).toBeUndefined();
		expect(receivedHopOf([`from a ([${IP}]) by b with no stamp`], IP)).toBeUndefined();
		expect(receivedHopOf([`from a ([${IP}]) by b; not a date`], IP)).toBeUndefined();
	});

	test("yields the deduplicated page links of the HTML and text parts, without images", async () => {
		const origin = await parseEmailOrigin(eml, IP);
		expect(origin.links).toEqual([LINK, "https://tracker.example.org/u?id=1"]);
		expect(origin.received?.at.toISOString()).toBe("2026-11-19T09:00:01.000Z");
	});

	test("belongs only to an IP target of a report that holds the email source", async () => {
		const artifacts = [{ mimeType: "message/rfc822", blob: Buffer.from(eml) }];
		expect((await emailOriginOf({ target: { targetType: "ip", normalizedTarget: IP }, evidenceArtifacts: artifacts }))?.links).toContain(LINK);
		expect(await emailOriginOf({ target: { targetType: "ip", normalizedTarget: IP }, evidenceArtifacts: [{ mimeType: "image/png", blob: Buffer.from("x") }] })).toBeUndefined();
		expect(await emailOriginOf({ target: { targetType: "domain", normalizedTarget: "sender.example" }, evidenceArtifacts: artifacts })).toBeUndefined();
	});

	test("with no Received line for the IP still has the links, and no time", async () => {
		const origin = await parseEmailOrigin(eml.replace(IP, "198.51.100.9"), IP);
		expect(origin.received).toBeUndefined();
		expect(origin.links).toContain(LINK);
	});
});

describe("Google Cloud report for an IP that sent a phishing email", () => {
	test("names the IP, the Received header, the links and the case before the narrative, within 1,000 characters", async () => {
		const emailOrigin = await parseEmailOrigin(eml, IP);
		const payload = buildGoogleCloudSubmissionPayload({ target: IP, observedUrls: [], description: analysis, capturedAt, caseUrl: CASE, emailOrigin });
		if (!payload) throw new Error("Expected a payload.");
		const details = payload.report.abuseDetails;
		expect(details.length).toBeLessThanOrEqual(1_000);
		expect(details).toStartWith(`Abusive IP address: ${IP} (first external Received hop of a phishing email sent from it)\nReceived header: from mail.sender.example`);
		expect(details).toContain(`Phishing URLs in the email:\n- ${LINK}\n- https://tracker.example.org/u?id=1\n`);
		expect(details).toContain("Date and time of the abuse: 2026-11-19T09:00:01Z (UTC).");
		expect(details).toContain(`Evidence (email source, screenshot, analysis): ${CASE}`);
		expect(details.indexOf(CASE)).toBeLessThan(details.indexOf("A phishing email sent from Google infrastructure"));
		expect(details).toContain("The email indicates");
		expect(details).not.toContain("None clearly stated");
		expect(details).not.toContain("captured page");
		expect(payload.report).toMatchObject({ service: "compute_engine", abuseDate: "11/19/2026" });
		expect(payload.target.observedUrls).toEqual([]);
		expect(payload.emailOrigin).toEqual({ links: emailOrigin.links, receivedAt: "2026-11-19T09:00:01.000Z" });
		expect(storedGoogleCloudSubmissionPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
	});

	test("falls back to the report time without a Received time, and keeps URLs when there are very many", () => {
		const links = Array.from({ length: 20 }, (_, index) => `https://storage.googleapis.com/bucket-${index}/${"x".repeat(60)}`);
		const payload = buildGoogleCloudSubmissionPayload({ target: IP, observedUrls: [], description: analysis, capturedAt, caseUrl: CASE, emailOrigin: { links, headers: "" } });
		if (!payload) throw new Error("Expected a payload.");
		expect(payload.report.abuseDate).toBe("11/20/2026");
		expect(payload.report.abuseDetails).toContain("Date and time of the abuse: 2026-11-20T08:00:00Z (UTC).");
		expect(payload.report.abuseDetails.length).toBeLessThanOrEqual(1_000);
		expect(payload.report.abuseDetails).toContain(`- ${links[0]}`);
		expect(payload.report.abuseDetails).toContain(CASE);
	});

	test("skips a link too long for the field instead of dropping the rest", () => {
		const links = [`https://storage.googleapis.com/b/${"y".repeat(700)}`, "https://example.org/second"];
		const payload = buildGoogleCloudSubmissionPayload({ target: IP, observedUrls: [], description: analysis, capturedAt, caseUrl: CASE, emailOrigin: { links, headers: "" } });
		expect(payload?.report.abuseDetails.length).toBeLessThanOrEqual(1_000);
		expect(payload?.report.abuseDetails).not.toContain("yyyy");
		expect(payload?.report.abuseDetails).toContain("- https://example.org/second");
	});

	test("is refused for a domain target, and a tampered or empty draft is not read", async () => {
		const emailOrigin = await parseEmailOrigin(eml, IP);
		expect(buildGoogleCloudSubmissionPayload({ target: "sites.google.com", observedUrls: [], description: analysis, capturedAt, emailOrigin })).toBeUndefined();
		const payload = buildGoogleCloudSubmissionPayload({ target: IP, observedUrls: [], description: analysis, capturedAt, caseUrl: CASE, emailOrigin })!;
		const stored = (change: object) => storedGoogleCloudSubmissionPayload({ ...payload, ...change });
		expect(stored({})).toEqual(payload);
		expect(stored({ emailOrigin: undefined })).toBeUndefined();
		expect(stored({ emailOrigin: { links: ["javascript:alert(1)"] } })).toBeUndefined();
		expect(stored({ emailOrigin: { links: [LINK], receivedAt: "yesterday" } })).toBeUndefined();
		expect(stored({ emailOrigin: { links: "x" } })).toBeUndefined();
	});

	async function ipRoute(createReport: () => Promise<bigint>) {
		const reportId = await createReport();
		const target = (await AbuseRepository.listTargets(reportId)).find((item) => item.targetType === "ip")!;
		const route = await AbuseRepository.upsertResolvedRoute(target.id, contactRoute({ email: "google-cloud-compliance@google.com", providerName: "Google LLC", provenance: {}, snapshot: {} }));
		return { reportId, route };
	}

	test("is prepared from the stored email of the report, as production's route would be", async () => {
		const { route } = await ipRoute(async () => {
			const submissionId = 382165893943136282n;
			await SubmissionsEntity.create({ id: submissionId, kind: "email", data: { kind: "email" }, dedupeKey: "google-email-origin" });
			return (await reportConfirmedEmailPhishing({ submissionId, analysisText: analysis, redactedEml: eml, sendingIp: IP, reporter: {} })).reportId;
		});
		const preparation = await prepareGoogleCloudSubmission({ routeId: route.id, payload: {} });
		if (preparation.outcome !== "ready") throw new Error(`Expected ready, got ${preparation.reason}`);
		const payload = storedGoogleCloudSubmissionPayload(preparation.payload);
		expect(payload?.report.abuseDetails).toContain(`Abusive IP address: ${IP}`);
		expect(payload?.report.abuseDetails).toContain(LINK);
		expect(payload?.report.abuseDetails).toContain(CASE);
		expect(payload?.report.abuseDate).toBe("11/19/2026");
	});

	test("a bare IP without the email or observed URLs still has insufficient evidence", async () => {
		const { route } = await ipRoute(async () => {
			const request = await validateAbuseReportRequest({ targets: [IP], allegationCategory: "phishing", description: analysis });
			return (await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } })).reportId;
		});
		await expect(prepareGoogleCloudSubmission({ routeId: route.id, payload: {} })).resolves.toEqual({ outcome: "insufficient_evidence", reason: "google_cloud_requires_an_observed_url" });
	});
});

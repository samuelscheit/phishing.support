import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../../../db/entities/submissions";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { validateAbuseReportRequest } from "../../contracts";
import { AbuseRepository } from "../../repository";
import { contactRoute } from "../../resolver/routes";
import { reportConfirmedEmailPhishing } from "../../submission_reports";
import { parseEmailOrigin } from "../email_origin";
import { MICROSOFT_PROVIDER } from "./definition";
import { buildMicrosoftSubmissionPayload, makeMicrosoftEmailNotes, microsoftRequestBody, storedMicrosoftSubmissionPayload } from "./payload";
import { prepareMicrosoftSubmission, submitMicrosoftSubmission } from "./submission";

useTemporaryDatabase();

const IP = "20.50.1.2";
const LINK = "https://evil-pay.example.org/renew?id=7";
const OTHER_LINK = "https://tracker.example.net/u/1";
const CASE = "https://phishing.support/submissions/42";
const REFERENCE = "PS-8fc84cc01019-R381763380685313515";
const RECEIVED_OLD = "Received: from relay.internal (relay.internal [10.0.0.4])\r\n\tby mx.example.net with ESMTP id abc; Thu, 19 Nov 2026 10:00:03 +0000";
const RECEIVED_HOP = `Received: from mail.sender.example (mail.sender.example [${IP}])\r\n\tby mx.example.net (Postfix) with ESMTPS id 4F1; Thu, 19 Nov 2026 10:00:01 +0100 (CET)`;
const eml = [
	RECEIVED_OLD,
	RECEIVED_HOP,
	"From: Antivirus Billing <billing@sender.example>",
	"To: [redacted] <[redacted]>",
	"Subject: Your payment was declined",
	"Content-Type: text/plain; charset=utf-8",
	"",
	`Renew now: ${LINK} and ${OTHER_LINK}`,
	"",
].join("\r\n");
const analysis = "- **Claimed brand:** Norton LifeLock. The email asks for a payment to renew an antivirus subscription and links to a page collecting card details.";
const capturedAt = new Date("2026-11-20T08:00:00.000Z");
const NOW = new Date("2026-11-20T11:02:41.500Z");
const input = { target: IP, observedUrls: [], description: analysis, allegationCategory: "phishing", legalBrandUrl: "https://www.norton.com/", reference: REFERENCE, caseUrl: CASE, capturedAt };

describe("MSRC report for the IP that sent a phishing email", () => {
	test("is threatType IP Address, incidentType Spam, the address as ipAddressList source, the links in the notes", async () => {
		const emailOrigin = await parseEmailOrigin(eml, IP);
		const payload = buildMicrosoftSubmissionPayload({ ...input, emailOrigin })!;
		expect(payload.report).toMatchObject({ threatType: "IP Address", incidentType: "Spam", urls: [], sourceIp: IP, observedAt: "2026-11-19T09:00:01.000Z", reference: REFERENCE });
		const { notes } = payload.report;
		expect(notes.startsWith(`Reference: ${REFERENCE}\n\nA phishing email sent from Microsoft infrastructure at ${IP} is being reported.`)).toBeTrue();
		expect(notes).toContain("The email appears to impersonate Norton LifeLock");
		expect(notes).not.toContain("captured page");
		expect(notes).not.toContain("hosted on Microsoft services");
		expect(notes).toContain([
			`Sending IP address: ${IP} (first external Received hop of a phishing email sent from it)`,
			`Received header: from mail.sender.example (mail.sender.example [${IP}]) by mx.example.net (Postfix) with ESMTPS id 4F1; Thu, 19 Nov 2026 10:00:01 +0100 (CET)`,
			"Date and time of the email: 2026-11-19T09:00:01Z (UTC)",
		].join("\n"));
		expect(notes.endsWith(`Phishing URLs in the email:\n- ${LINK}\n- ${OTHER_LINK}\n\nCase details and screenshots: ${CASE}`)).toBeTrue();
		expect(notes.length).toBeLessThanOrEqual(MICROSOFT_PROVIDER.notesMaximumLength);
		expect(storedMicrosoftSubmissionPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
	});

	test("posts exactly the API's request: no urlList, the email's time in UTC", async () => {
		const payload = buildMicrosoftSubmissionPayload({ ...input, emailOrigin: await parseEmailOrigin(eml, IP) })!;
		const body = microsoftRequestBody(payload, NOW);
		expect(body).toEqual({
			threatType: "IP Address",
			source: "CertPortalV2",
			reporterName: "Phishing Support",
			reporterEmail: "support@phishing.support",
			reporterOrg: "Phishing Support",
			phoneNumber: "",
			incidentType: "Spam",
			ipAddressList: [{ sourceIp: IP }],
			reportNotes: payload.report.notes,
			date: "2026-11-19",
			time: "09:00",
			timeZone: "+0000",
			anonymizeReport: false,
		});
		expect(Object.keys(body)).not.toContain("urlList");
	});

	test("an email time ahead of the filing time is clamped to it, as the form refuses the future", async () => {
		const origin = await parseEmailOrigin(eml.replace("Thu, 19 Nov 2026 10:00:01 +0100", "Sat, 21 Nov 2026 10:00:01 +0000"), IP);
		const payload = buildMicrosoftSubmissionPayload({ ...input, emailOrigin: origin })!;
		expect(microsoftRequestBody(payload, NOW)).toMatchObject({ date: "2026-11-20", time: "11:02", timeZone: "+0000" });
	});

	test("falls back to the report time when no Received header states one", async () => {
		const origin = await parseEmailOrigin(eml.replace(IP, "198.51.100.9"), IP);
		const payload = buildMicrosoftSubmissionPayload({ ...input, emailOrigin: origin })!;
		expect(payload.report.observedAt).toBe("2026-11-20T08:00:00.000Z");
		expect(payload.report.notes).toContain("Date and time of the email: 2026-11-20T08:00:00Z (UTC)");
		expect(microsoftRequestBody(payload, NOW)).toMatchObject({ date: "2026-11-20", time: "08:00" });
	});

	test("keeps the notes within 2,000 characters: a long Received header is cut, links that do not fit are skipped", () => {
		const links = [`https://a.example.org/${"x".repeat(1_900)}`, ...Array.from({ length: 12 }, (_, index) => `https://l${index}.example.org/p`)];
		const received = { line: `from a (b [${IP}]) ${"z".repeat(900)}`, at: new Date("2026-11-19T09:00:01Z") };
		const notes = makeMicrosoftEmailNotes({ ...input, hostingLine: "h".repeat(300) }, { links, headers: "x", received }, capturedAt)!;
		expect(notes.length).toBeLessThanOrEqual(MICROSOFT_PROVIDER.notesMaximumLength);
		expect(notes).not.toContain("z".repeat(MICROSOFT_PROVIDER.emailReceivedMaximumLength + 1));
		expect(notes).not.toContain("xxxx");
		expect(notes).toContain("- https://l0.example.org/p");
		expect(notes).toContain(CASE);
		expect(notes).not.toContain("hhhh");
		expect(makeMicrosoftEmailNotes({ ...input, caseUrl: `https://phishing.support/${"c".repeat(2_000)}` }, { links: [], headers: "x" }, capturedAt)).toBeUndefined();
	});

	test("is refused for a domain target and a malformed reference", async () => {
		const emailOrigin = await parseEmailOrigin(eml, IP);
		expect(buildMicrosoftSubmissionPayload({ ...input, target: "sender.example", emailOrigin })).toBeUndefined();
		expect(buildMicrosoftSubmissionPayload({ ...input, reference: "nope", emailOrigin })).toBeUndefined();
	});

	test("the website path is unchanged: URL threat, URLs, no IP fields", () => {
		const payload = buildMicrosoftSubmissionPayload({ ...input, target: "x.azurewebsites.net", observedUrls: ["https://x.azurewebsites.net/signin"] })!;
		expect(payload.report).toMatchObject({ threatType: "URL", incidentType: "Phishing", urls: ["https://x.azurewebsites.net/signin"] });
		expect(payload.report.sourceIp).toBeUndefined();
		expect(payload.report.observedAt).toBeUndefined();
		expect(microsoftRequestBody(payload, NOW)).toEqual({
			threatType: "URL",
			source: "CertPortalV2",
			reporterName: "Phishing Support",
			reporterEmail: "support@phishing.support",
			reporterOrg: "Phishing Support",
			phoneNumber: "",
			incidentType: "Phishing",
			urlList: [{ sourceUrl: "https://x.azurewebsites.net/signin" }],
			reportNotes: payload.report.notes,
			date: "2026-11-20",
			time: "11:02",
			timeZone: "+0000",
			anonymizeReport: false,
		});
	});

	test("a stored draft is read only in the exact shape of its threat type", async () => {
		const payload = buildMicrosoftSubmissionPayload({ ...input, emailOrigin: await parseEmailOrigin(eml, IP) })!;
		const stored = (change: (report: Record<string, unknown>) => void, target?: string) => {
			const copy = JSON.parse(JSON.stringify(payload));
			change(copy.report);
			if (target) copy.target.normalizedTarget = target;
			return storedMicrosoftSubmissionPayload(copy);
		};
		expect(stored(() => undefined)).toEqual(payload);
		expect(stored((report) => { report.incidentType = "Phishing"; })).toBeUndefined();
		expect(stored((report) => { report.incidentType = "Malware"; })).toBeUndefined();
		expect(stored((report) => { delete report.sourceIp; })).toBeUndefined();
		expect(stored((report) => { report.sourceIp = "20.50.1.3"; })).toBeUndefined();
		expect(stored((report) => { delete report.observedAt; })).toBeUndefined();
		expect(stored((report) => { report.observedAt = "yesterday"; })).toBeUndefined();
		expect(stored((report) => { report.observedAt = "2026-11-19"; })).toBeUndefined();
		expect(stored((report) => { report.urls = [LINK]; })).toBeUndefined();
		expect(stored((report) => { report.threatType = "Gaming"; })).toBeUndefined();
		expect(stored((report) => { delete report.threatType; })).toBeUndefined();
		expect(stored(() => undefined, "sender.example")).toBeUndefined();
		const web = buildMicrosoftSubmissionPayload({ ...input, target: "x.azurewebsites.net", observedUrls: ["https://x.azurewebsites.net/signin"] })!;
		expect(storedMicrosoftSubmissionPayload({ ...web, report: { ...web.report, sourceIp: IP } })).toBeUndefined();
		expect(storedMicrosoftSubmissionPayload({ ...web, report: { ...web.report, urls: [] } })).toBeUndefined();
		expect(storedMicrosoftSubmissionPayload({ ...web, report: { ...web.report, incidentType: "Spam" } })).toBeUndefined();
	});
});

describe("MSRC submission of a phishing email's sending IP", () => {
	async function ipRoute(createReport: () => Promise<bigint>) {
		const reportId = await createReport();
		const target = (await AbuseRepository.listTargets(reportId)).find((item) => item.targetType === "ip")!;
		const route = await AbuseRepository.upsertResolvedRoute(target.id, contactRoute({ email: "abuse@microsoft.com", providerName: "Microsoft", provenance: {}, snapshot: {} }));
		return { reportId, route };
	}

	test("is prepared from the stored email of the report and posts IP Address / Spam", async () => {
		const { route } = await ipRoute(async () => {
			const submissionId = 382165893943136284n;
			await SubmissionsEntity.create({ id: submissionId, kind: "email", data: { kind: "email" }, dedupeKey: "msrc-email-origin" });
			return (await reportConfirmedEmailPhishing({ submissionId, analysisText: analysis, redactedEml: eml, sendingIp: IP, reporter: {} })).reportId;
		});
		const preparation = await prepareMicrosoftSubmission({ routeId: route.id, payload: {} });
		if (preparation.outcome !== "ready") throw new Error(`Expected ready, got ${preparation.reason}`);
		const payload = storedMicrosoftSubmissionPayload(preparation.payload)!;
		expect(payload.report).toMatchObject({ threatType: "IP Address", incidentType: "Spam", sourceIp: IP, observedAt: "2026-11-19T09:00:01.000Z" });
		expect(payload.report.notes).toContain(LINK);
		expect(payload.report.notes).toContain("https://phishing.support/submissions/382165893943136284");

		const sent: { url: string; body: any }[] = [];
		const success = await submitMicrosoftSubmission(
			{ routeId: route.id, payload: payload as unknown as Record<string, unknown> },
			{ now: () => NOW, fetch: async (url, init) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response("", { status: 200 }); } },
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.url).toBe(MICROSOFT_PROVIDER.endpoint);
		expect(sent[0]!.body).toMatchObject({ threatType: "IP Address", incidentType: "Spam", ipAddressList: [{ sourceIp: IP }], date: "2026-11-19", time: "09:00", timeZone: "+0000" });
		expect(sent[0]!.body.urlList).toBeUndefined();
		expect(success.submittedTargets).toEqual([IP]);
	});

	test("a bare IP, with no email and no observed URL, is insufficient evidence instead of a made-up https://ip/ site", async () => {
		const { route } = await ipRoute(async () => {
			const request = await validateAbuseReportRequest({ targets: [IP], allegationCategory: "phishing", description: analysis });
			return (await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } })).reportId;
		});
		await expect(prepareMicrosoftSubmission({ routeId: route.id, payload: {} })).resolves.toEqual({ outcome: "insufficient_evidence", reason: "microsoft_requires_an_observed_url_or_the_phishing_email" });
	});

	test("an IP with an observed URL is still reported as a site", async () => {
		const { route } = await ipRoute(async () => {
			const request = await validateAbuseReportRequest({ targets: [IP], allegationCategory: "phishing", description: analysis, observedUrls: [{ target: IP, urls: [`https://${IP}/login`] }] });
			return (await AbuseRepository.createReport({ request, reporter: { reporterIp: "8.8.8.8" } })).reportId;
		});
		const preparation = await prepareMicrosoftSubmission({ routeId: route.id, payload: {} });
		if (preparation.outcome !== "ready") throw new Error(`Expected ready, got ${preparation.reason}`);
		expect(storedMicrosoftSubmissionPayload(preparation.payload)?.report).toMatchObject({ threatType: "URL", incidentType: "Phishing", urls: [`https://${IP}/login`] });
	});
});

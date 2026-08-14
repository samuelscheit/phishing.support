import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import {
	ArtifactsEntity,
	ProviderReportsEntity,
	ReportingSummaryEntity,
	SubmissionsEntity,
} from "../db/entities";
import { useTemporaryDatabase } from "../db/test_helpers";
import { getSubmissionDetails } from "../submissions/details";
import {
	NETCRAFT_MAXIMUM_MAIL_MESSAGE_BYTES,
	NETCRAFT_REPORT_MAIL_URL,
} from "../netcraft/api";
import {
	buildNetcraftMailPayload,
	reportNetcraftMail,
} from "./netcraft_mail";

useTemporaryDatabase();

const originalReporterEmail = process.env.ABUSE_NETCRAFT_REPORTER_EMAIL;

beforeEach(() => {
	process.env.ABUSE_NETCRAFT_REPORTER_EMAIL = "netcraft-reports@phishing.support";
});

afterAll(() => {
	if (originalReporterEmail === undefined) delete process.env.ABUSE_NETCRAFT_REPORTER_EMAIL;
	else process.env.ABUSE_NETCRAFT_REPORTER_EMAIL = originalReporterEmail;
});

function rawEmail(subject = "Credential verification") {
	return [
		"From: Fake Service <notice@phish.example.test>",
		"To: victim@example.test",
		`Subject: ${subject}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Confirm your password at https://phish.example.test/login",
	].join("\r\n");
}

async function createEmailSubmission(key: string) {
	return SubmissionsEntity.create({
		kind: "email",
		data: { kind: "email" },
		dedupeKey: `netcraft-mail-${key}`,
	});
}

describe("Netcraft mail reporting", () => {
	test("uses the untouched RFC 822/MIME source and validates the documented message limit", () => {
		const source = rawEmail();
		const payload = buildNetcraftMailPayload({
			reporterEmail: " Netcraft-Reports@Phishing.Support ",
			rawMime: source,
		});

		expect(payload).toMatchObject({
			email: "netcraft-reports@phishing.support",
			message: source,
			messageBytes: Buffer.byteLength(source, "utf-8"),
		});
		expect(payload.messageSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(() => buildNetcraftMailPayload({ reporterEmail: "reports@phishing.support", rawMime: "" })).toThrow("non-empty raw RFC 822/MIME");
		expect(() => buildNetcraftMailPayload({
			reporterEmail: "reports@phishing.support",
			rawMime: "x".repeat(NETCRAFT_MAXIMUM_MAIL_MESSAGE_BYTES + 1),
		})).toThrow(`up to ${NETCRAFT_MAXIMUM_MAIL_MESSAGE_BYTES} bytes`);
	});

	test("marks the durable boundary before POST, preserves the UUID/status URL, and exposes no raw provider payload", async () => {
		const submissionId = await createEmailSubmission("accepted");
		const source = rawEmail("Urgent sign-in request");
		const artifactId = await ArtifactsEntity.saveBuffer({
			submissionId,
			name: "mail.eml",
			kind: "eml",
			mimeType: "message/rfc822",
			buffer: Buffer.from(source, "utf-8"),
		});
		let requestBody: Record<string, unknown> | undefined;

		const result = await reportNetcraftMail({
			submissionId,
			rawMime: source,
			originalEmlArtifactId: artifactId,
		}, {
			fetch: async (input, init) => {
				expect(String(input)).toBe(NETCRAFT_REPORT_MAIL_URL);
				expect(init?.method).toBe("POST");
				expect(init?.redirect).toBe("error");
				expect(new Headers(init?.headers).get("accept")).toBe("application/json");
				expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
				requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

				const [duringCall] = await ProviderReportsEntity.listForSubmission(submissionId);
				expect(duringCall).toMatchObject({ status: "submission_started" });
				expect(await ReportingSummaryEntity.hasSuccessfulReport(submissionId)).toBeFalse();
				return new Response(JSON.stringify({
					message: "Successfully reported",
					uuid: "AaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa",
				}));
			},
		});

		expect(requestBody).toEqual({ email: "netcraft-reports@phishing.support", message: source });
		expect(result).toEqual({
			outcome: "submitted",
			providerReportId: expect.any(BigInt),
			confirmationId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			finalUrl: "https://report.netcraft.com/api/v3/submission/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});

		const [report] = await ProviderReportsEntity.listForSubmission(submissionId);
		expect(report).toMatchObject({
			channel: "netcraft_mail_v3",
			status: "sent",
			providerMessageId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			providerSubmissionUrl: "https://report.netcraft.com/api/v3/submission/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			attachmentsArtifactIds: [artifactId.toString()],
		});
		expect(report?.sentAt).toBeInstanceOf(Date);
		expect(await ReportingSummaryEntity.hasSuccessfulReport(submissionId)).toBeTrue();

		const details = await getSubmissionDetails(submissionId.toString());
		expect(details?.providerReports[0]).toMatchObject({
			providerSubmissionUrl: "https://report.netcraft.com/api/v3/submission/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		});
		expect(JSON.stringify(details)).not.toContain(source);
		expect(Object.keys(details!.providerReports[0]!)).not.toContain("data");
	});

	test("never replays a report while or after its durable boundary is present", async () => {
		const submissionId = await createEmailSubmission("no-replay");
		let calls = 0;
		let resolveResponse: ((response: Response) => void) | undefined;
		let markFetchStarted: (() => void) | undefined;
		const fetchStarted = new Promise<void>((resolve) => {
			markFetchStarted = resolve;
		});
		const first = reportNetcraftMail({ submissionId, rawMime: rawEmail() }, {
			fetch: async () => {
				calls++;
				markFetchStarted?.();
				return await new Promise<Response>((resolve) => {
					resolveResponse = resolve;
				});
			},
		});

		await fetchStarted;
		const duplicateDuringCall = await reportNetcraftMail({
			submissionId,
			rawMime: rawEmail("Changed source must not be sent"),
		}, { fetch: async () => {
			calls++;
			return new Response(JSON.stringify({ uuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }));
		} });
		expect(duplicateDuringCall).toMatchObject({ outcome: "unknown_external_state" });
		expect(calls).toBe(1);

		resolveResponse!(new Response(JSON.stringify({ uuid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" })));
		expect((await first).outcome).toBe("submitted");

		const duplicateAfterCall = await reportNetcraftMail({ submissionId, rawMime: rawEmail() }, { fetch: async () => {
			calls++;
			return new Response(JSON.stringify({ uuid: "cccccccccccccccccccccccccccccccc" }));
		} });
		expect(duplicateAfterCall).toMatchObject({ outcome: "already_processed", status: "sent" });
		expect(calls).toBe(1);
	});

	test("records explicit Netcraft rejections as failed but leaves transport and malformed-success outcomes unreplayable", async () => {
		const rejectedSubmissionId = await createEmailSubmission("rejected");
		const rejected = await reportNetcraftMail({ submissionId: rejectedSubmissionId, rawMime: rawEmail() }, {
			fetch: async () => new Response(JSON.stringify({ error: "Invalid message" }), { status: 400 }),
		});
		expect(rejected).toMatchObject({ outcome: "rejected" });
		expect(await ProviderReportsEntity.listForSubmission(rejectedSubmissionId)).toEqual([
			expect.objectContaining({ status: "failed", providerMessageId: null }),
		]);
		expect(await ReportingSummaryEntity.hasSuccessfulReport(rejectedSubmissionId)).toBeFalse();

		const ambiguousSubmissionId = await createEmailSubmission("ambiguous");
		let ambiguousCalls = 0;
		const ambiguous = await reportNetcraftMail({ submissionId: ambiguousSubmissionId, rawMime: rawEmail() }, {
			fetch: async () => {
				ambiguousCalls++;
				return new Response("not json");
			},
		});
		expect(ambiguous).toMatchObject({ outcome: "unknown_external_state" });
		expect(await ProviderReportsEntity.listForSubmission(ambiguousSubmissionId)).toEqual([
			expect.objectContaining({ status: "unknown_external_state" }),
		]);
		expect(await reportNetcraftMail({ submissionId: ambiguousSubmissionId, rawMime: rawEmail() }, { fetch: async () => {
			ambiguousCalls++;
			return new Response(JSON.stringify({ uuid: "dddddddddddddddddddddddddddddddd" }));
		} })).toMatchObject({ outcome: "unknown_external_state" });
		expect(ambiguousCalls).toBe(1);
	});

	test("rejects an oversized message before fetch and keeps it out of reporting success", async () => {
		const submissionId = await createEmailSubmission("oversized");
		let fetchCalled = false;
		const result = await reportNetcraftMail({
			submissionId,
			rawMime: "x".repeat(NETCRAFT_MAXIMUM_MAIL_MESSAGE_BYTES + 1),
		}, {
			fetch: async () => {
				fetchCalled = true;
				return new Response(JSON.stringify({ uuid: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }));
			},
		});

		expect(result).toMatchObject({ outcome: "preflight_failed" });
		expect(fetchCalled).toBeFalse();
		expect(await ProviderReportsEntity.listForSubmission(submissionId)).toEqual([
			expect.objectContaining({ status: "failed" }),
		]);
		expect(await ReportingSummaryEntity.hasSuccessfulReport(submissionId)).toBeFalse();
	});
});

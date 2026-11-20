import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { contactRoute } from "../../resolver/routes";
import { abuseTargets } from "../../schema";
import { jsonResponse as json, readyDraft } from "../kit/testing";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { awsProvider } from "./index";
import { AWS_PROVIDER } from "./definition";
import { providerResponseId } from "../kit/report_reference";
import { storedAwsSubmissionPayload } from "./payload";
import { awsDraft, submitAwsSubmission } from "./submission";

const verifiedAwsDraft = async (context: Parameters<typeof awsDraft.verify>[0]) => (await awsDraft.verify(context)).payload;

useTemporaryDatabase();

const TARGET = "login-example-phish.com";
const MAILBOXES = ["trustandsafety@support.aws.com", "abuse@amazonaws.com"];
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";
const NOW = new Date("2026-11-20T11:02:41.500Z");

const readyContext = (options: { target?: string; allegationCategory?: "phishing" | "malware"; observedUrls?: string[]; resolverProvenance?: Record<string, unknown> } = {}) => readyDraft({
	mailbox: MAILBOXES[0]!,
	providerName: "AWS",
	target: options.target ?? TARGET,
	allegationCategory: options.allegationCategory,
	observedUrls: options.observedUrls,
	provenance: options.resolverProvenance,
}, awsDraft.prepare, storedAwsSubmissionPayload);

type Sent = { url: string; init: RequestInit };
function fakeFetch(answer: Response | Error | (() => Response)) {
	const sent: Sent[] = [];
	const fetch = async (url: string, init: RequestInit) => {
		sent.push({ url, init });
		if (answer instanceof Error) throw answer;
		return typeof answer === "function" ? answer() : answer.clone();
	};
	return { fetch, sent };
}

describe("registry", () => {
	test("both AWS mailboxes resolve to the provider and nothing else claims them", async () => {
		const { getProviderSubmissionProviderForMailbox, listProviderSubmissionProviders } = await import("../submission_registry_default");
		for (const mailbox of MAILBOXES) {
			expect(getProviderSubmissionProviderForMailbox(mailbox)?.definition.key).toBe("aws_trust_safety");
			expect(getProviderSubmissionProviderForMailbox(` ${mailbox.toUpperCase()} `)?.definition.key).toBe("aws_trust_safety");
			expect(contactRoute({ email: mailbox, providerName: "AWS", provenance: {}, snapshot: {} })).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "aws_trust_safety", verifiedEmail: mailbox });
		}
		const owners = listProviderSubmissionProviders().filter((provider) => provider.definition.exactMailboxes.some((mailbox) => MAILBOXES.includes(mailbox.toLowerCase())));
		expect(owners.map((provider) => provider.definition.key)).toEqual(["aws_trust_safety"]);
		for (const mailbox of ["abuse@aws.com", "trustandsafety@aws.amazon.com", "abuse@sub.amazonaws.com"]) {
			expect(getProviderSubmissionProviderForMailbox(mailbox)).toBeUndefined();
		}
	});

	test("its mail is read as replies, matched by our reference", () => {
		expect(awsProvider.inboundMail).toMatchObject({ senderDomains: ["aws.com"], messageKind: "reply" });
		expect(awsProvider.inboundMail!.confirmationIds!("Reference: PS-8fc84cc01019-R7")).toEqual(["PS-8fc84cc01019-R7"]);
		expect(awsProvider.findSubmission).toBeUndefined();
		expect(awsProvider.fetchCorrespondence).toBeUndefined();
	});

});

describe("awsDraft.prepare", () => {
	test("drafts the target, its URLs and comments", async () => {
		const { payload, created, route } = await readyContext();
		expect(payload).toMatchObject({ target: { normalizedTarget: TARGET }, report: { abuseType: "phishing", urls: [`https://${TARGET}/signin`] } });
		expect(payload.report.comments).toContain(`Reference: ${payload.report.trackingId}`);
		expect(payload.report.comments).toContain("Impersonated brand: https://www.examplebank.com/");
		expect(payload.report.comments).not.toMatch(/[<>]/);
		expect(await verifiedAwsDraft({ routeId: route.id, payload: payload as never })).toEqual(payload);
	});

	test("the preview is the comments the draft stores, besides the reference", async () => {
		const { payload } = await readyContext();
		const preview = awsProvider.buildReportPreview!({ target: TARGET, observedUrls: [`https://${TARGET}/signin`], description, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/" })!;
		expect(preview).toContain("A suspected phishing site using AWS resources");
		expect(awsProvider.buildReportPreview!({ target: "not a host", observedUrls: [], description })).toBeUndefined();
		expect(payload.report.comments).toContain(preview.split("\n\n")[1]!);
	});

	test("an IP target, a malware report, and the hosting line are drafted", async () => {
		const ip = await readyContext({ target: "34.102.117.75", observedUrls: ["https://34.102.117.75/login"], allegationCategory: "malware" });
		expect(ip.payload.report).toMatchObject({ abuseType: "malware-website", urls: ["https://34.102.117.75/login"] });
		const hosted = await readyContext({ resolverProvenance: { source: "domain_infrastructure_ip", originatingIp: "34.102.117.75", originatingDomain: TARGET, dnsResolution: { publicAddresses: ["34.102.117.75"] } } });
		expect(hosted.payload.report.comments).toContain(`Hosting IP address: 34.102.117.75 (${TARGET} resolved to 34.102.117.75`);
	});

});

describe("verifiedAwsDraft", () => {
	test("rejects a malformed, retargeted or stale draft", async () => {
		const { context, payload, route, targetId } = await readyContext();
		await expect(verifiedAwsDraft({ routeId: route.id, payload: {} })).rejects.toThrow("malformed");
		await expect(verifiedAwsDraft({ routeId: route.id, payload: { ...payload, report: { ...payload.report, comments: `${payload.report.comments} edited` } } as never })).rejects.toThrow("no longer matches the report");
		await expect(verifiedAwsDraft({ routeId: route.id, payload: { ...payload, target: { normalizedTarget: "other.example.com" } } as never })).rejects.toThrow("no longer matches its route");
		await expect(verifiedAwsDraft({ routeId: route.id, payload: { ...payload, report: { ...payload.report, trackingId: "PS-000000000000-R1" } } as never })).rejects.toThrow("no longer matches the report");
		(await getDb()).update(abuseTargets).set({ observedUrls: [`https://${TARGET}/changed`] }).where(eq(abuseTargets.id, targetId)).run();
		await expect(verifiedAwsDraft(context)).rejects.toThrow("no longer matches the report");
	});
});

describe("submitAwsSubmission", () => {
	test("posts the form's request and confirms with our reference; nothing else is sent", async () => {
		const { context, payload } = await readyContext();
		const fake = fakeFetch(json({ data: { caseId: "179517163600449" } }));
		const success = await submitAwsSubmission(context, { fetch: fake.fetch, now: () => NOW });
		expect(success).toEqual({
			confirmationId: payload.report.trackingId,
			confirmationText: "AWS Trust & Safety accepted the report (179517163600449)",
			finalUrl: "https://support.aws.amazon.com/#/contacts/report-abuse",
			submittedTargets: [TARGET],
		});
		expect(fake.sent).toHaveLength(1);
		const { url, init } = fake.sent[0]!;
		expect(url).toBe("https://api.support.aws.amazon.com/v1/contacts/report-abuse-v2");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "content-type": "application/json", accept: "application/json, text/plain, */*", origin: "https://support.aws.amazon.com" });
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(String(init.body))).toEqual({
			content: {
				message: {
					abuse_source: "aws-owned-resource",
					abuse_group: "web_content",
					abuse_type: "phishing",
					web_content_events: [{ web_content_url: `https://${TARGET}/signin`, timestamp: "2026-11-20T11:02:00+00:00" }],
					comments: payload.report.comments,
					reporter: { first_name: "Phishing", last_name: "Support", email_address: "support@phishing.support", phone: "", organization: "Phishing Support", description: "independent-researcher", tracking_id: payload.report.trackingId },
				},
			},
		});
	});

	test("a malware report files the malware type", async () => {
		const { context } = await readyContext({ allegationCategory: "malware" });
		const fake = fakeFetch(json({ data: true }));
		await submitAwsSubmission(context, { fetch: fake.fetch, now: () => NOW });
		expect(JSON.parse(String(fake.sent[0]!.init.body)).content.message.abuse_type).toBe("malware-website");
	});

	test("an answer without an id still confirms", async () => {
		const { context, payload } = await readyContext();
		// The form files on any truthy answer body: an object, also an empty one, an array, true, a string.
		for (const answer of [{ data: true }, { data: null }, { status: "created" }, {}, [1], true, "ok"]) {
			const success = await submitAwsSubmission(context, { fetch: fakeFetch(json(answer)).fetch, now: () => NOW });
			expect(success).toMatchObject({ confirmationId: payload.report.trackingId, confirmationText: "AWS Trust & Safety accepted the report", submittedTargets: [TARGET] });
		}
	});

	test("reads a case id from the answer defensively", () => {
		expect(providerResponseId({ caseId: "179517163600449" })).toBe("179517163600449");
		expect(providerResponseId({ data: { caseId: "179517163600449" } })).toBeUndefined();
		expect(providerResponseId({ case_number: 179517163600449 })).toBe("179517163600449");
		expect(providerResponseId("P01M7ABCDE")).toBe("P01M7ABCDE");
		expect(providerResponseId({ id: "a b" })).toBeUndefined();
		expect(providerResponseId({ caseId: { nested: 1 } })).toBeUndefined();
		expect(providerResponseId(true)).toBeUndefined();
		expect(providerResponseId(null)).toBeUndefined();
	});

	test("a refused request means nothing was filed", async () => {
		const { context } = await readyContext();
		for (const status of [400, 413, 422]) {
			const error = await submitAwsSubmission(context, { fetch: fakeFetch(json({ message: "Invalid comments" }, status)).fetch, now: () => NOW }).catch((caught) => caught);
			expect(error).toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error.message).toContain(`HTTP ${status}`);
			expect(error.message).toContain("Invalid comments");
		}
		const empty = await submitAwsSubmission(context, { fetch: fakeFetch(new Response("", { status: 400 })).fetch }).catch((caught) => caught);
		expect(empty).toBeInstanceOf(ProviderSubmissionRejectedError);
	});

	test("every other failure is ambiguous: a plain error, never a rejection", async () => {
		const { context } = await readyContext();
		const cases: Array<[string, Response | Error]> = [
			["403", json({ message: "Forbidden" }, 403)],
			["429", json({ message: "Too many requests" }, 429)],
			["500", json({ message: "boom" }, 500)],
			["502", new Response("<html>bad gateway</html>", { status: 502 })],
			["not JSON", new Response("<html>ok</html>", { status: 200 })],
			["null", json(null)],
			["false", json(false)],
			["empty string", json("")],
			["empty body", new Response("", { status: 200 })],
			["network", new TypeError("fetch failed")],
			["timeout", new DOMException("The operation timed out.", "TimeoutError")],
		];
		for (const [name, answer] of cases) {
			const error = await submitAwsSubmission(context, { fetch: fakeFetch(answer).fetch, now: () => NOW }).catch((caught) => caught);
			expect(error, name).toBeInstanceOf(Error);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionRejectedError);
		}
	});

	test("the worker's deadline aborts the request", async () => {
		const { context } = await readyContext();
		const controller = new AbortController();
		const fetch = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.aborted ? reject(init.signal!.reason) : init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
		const pending = submitAwsSubmission({ ...context, signal: controller.signal }, { fetch, now: () => NOW });
		controller.abort(new Error("deadline"));
		await expect(pending).rejects.toThrow("deadline");
		expect(AWS_PROVIDER.timeoutMs).toBeGreaterThan(0);
	});

	test("a draft that no longer matches the report is never sent", async () => {
		const { context } = await readyContext();
		const fake = fakeFetch(json({ data: true }));
		await expect(submitAwsSubmission({ ...context, payload: { ...context.payload, adapter: "other" } }, { fetch: fake.fetch })).rejects.toThrow("malformed");
		expect(fake.sent).toHaveLength(0);
	});
});

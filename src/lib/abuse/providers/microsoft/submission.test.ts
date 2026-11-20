import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { contactRoute } from "../../resolver/routes";
import { abuseTargets } from "../../schema";
import { jsonResponse as json, readyDraft } from "../kit/testing";
import { reportReference } from "../report_reference";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { MICROSOFT_PROVIDER } from "./definition";
import { microsoftProvider } from "./index";
import { storedMicrosoftSubmissionPayload } from "./payload";
import { prepareMicrosoftSubmission, submitMicrosoftSubmission, verifiedMicrosoftDraft } from "./submission";

useTemporaryDatabase();

const TARGET = "login-example-phish.azurewebsites.net";
const MAILBOXES = ["abuse@microsoft.com", "cert@microsoft.com"];
const description = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";
const NOW = new Date("2026-11-20T11:02:41.500Z");

const readyContext = (options: { target?: string; allegationCategory?: "phishing" | "malware"; observedUrls?: string[]; resolverProvenance?: Record<string, unknown> } = {}) => readyDraft({
	mailbox: MAILBOXES[0]!,
	providerName: "Microsoft",
	target: options.target ?? TARGET,
	allegationCategory: options.allegationCategory,
	observedUrls: options.observedUrls,
	provenance: options.resolverProvenance,
}, prepareMicrosoftSubmission, storedMicrosoftSubmissionPayload);

type Sent = { url: string; init: RequestInit };
function fakeFetch(answer: Response | Error) {
	const sent: Sent[] = [];
	const fetch = async (url: string, init: RequestInit) => {
		sent.push({ url, init });
		if (answer instanceof Error) throw answer;
		return answer.clone();
	};
	return { fetch, sent };
}

describe("registry", () => {
	test("both Microsoft mailboxes resolve to the provider and nothing else claims them", async () => {
		const { getProviderSubmissionProviderForMailbox, listProviderSubmissionProviders } = await import("../submission_registry_default");
		for (const mailbox of MAILBOXES) {
			expect(getProviderSubmissionProviderForMailbox(mailbox)?.definition.key).toBe("microsoft_msrc");
			expect(getProviderSubmissionProviderForMailbox(` ${mailbox.toUpperCase()} `)?.definition.key).toBe("microsoft_msrc");
			expect(contactRoute({ email: mailbox, providerName: "Microsoft", provenance: {}, snapshot: {} })).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "microsoft_msrc", verifiedEmail: mailbox });
		}
		const owners = listProviderSubmissionProviders().filter((provider) => provider.definition.exactMailboxes.some((mailbox) => MAILBOXES.includes(mailbox.toLowerCase())));
		expect(owners.map((provider) => provider.definition.key)).toEqual(["microsoft_msrc"]);
		for (const mailbox of ["abuse@outlook.com", "abuse@sub.microsoft.com", "msrc@microsoft.com"]) {
			expect(getProviderSubmissionProviderForMailbox(mailbox)).toBeUndefined();
		}
	});

	test("it names no inbound mail, status or correspondence source", () => {
		expect(microsoftProvider.inboundMail).toBeUndefined();
		expect(microsoftProvider.findSubmission).toBeUndefined();
		expect(microsoftProvider.fetchCorrespondence).toBeUndefined();
	});

});

describe("prepareMicrosoftSubmission", () => {
	test("drafts a ready payload keyed by the route's reference", async () => {
		const { payload, created, route } = await readyContext();
		expect(payload.report.reference).toBe(reportReference(created.reportId, route.id));
		expect(payload).toMatchObject({ target: { normalizedTarget: TARGET }, report: { incidentType: "Phishing", urls: [`https://${TARGET}/signin`] } });
		expect(payload.report.notes.startsWith(`Reference: ${payload.report.reference}`)).toBeTrue();
		expect(payload.report.notes).toContain("Impersonated brand: https://www.examplebank.com/");
		// The test report has no public submission, hence no case page line (payload.test covers it).
		expect(payload.report.notes).not.toContain("Case details");
		expect(await verifiedMicrosoftDraft({ routeId: route.id, payload: payload as never })).toEqual(payload);
	});

	test("the preview is the notes the draft stores, besides the reference", async () => {
		const { payload } = await readyContext();
		const preview = microsoftProvider.buildReportPreview!({ target: TARGET, observedUrls: [`https://${TARGET}/signin`], description, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/" })!;
		expect(preview).toContain("A suspected phishing site hosted on Microsoft services");
		expect(microsoftProvider.buildReportPreview!({ target: "not a host", observedUrls: [], description })).toBeUndefined();
		expect(payload.report.notes).toContain(preview.split("\n\n")[1]!);
	});

	test("an IP target, a malware report, and the hosting line are drafted", async () => {
		const ip = await readyContext({ target: "20.50.1.2", observedUrls: ["https://20.50.1.2/login"], allegationCategory: "malware" });
		expect(ip.payload.report).toMatchObject({ incidentType: "Malware", urls: ["https://20.50.1.2/login"] });
		const hosted = await readyContext({ resolverProvenance: { source: "domain_infrastructure_ip", originatingIp: "20.50.1.2", originatingDomain: TARGET, dnsResolution: { publicAddresses: ["20.50.1.2"] } } });
		expect(hosted.payload.report.notes).toContain(`Hosting IP address: 20.50.1.2 (${TARGET} resolved to 20.50.1.2`);
	});

	test("an unknown route fails", async () => {
		await expect(prepareMicrosoftSubmission({ routeId: 999_999n, payload: {} })).rejects.toThrow("no longer exists");
	});
});

describe("verifiedMicrosoftDraft", () => {
	test("rejects a malformed, retargeted or stale draft", async () => {
		const { context, payload, route, targetId } = await readyContext();
		await expect(verifiedMicrosoftDraft({ routeId: route.id, payload: {} })).rejects.toThrow("malformed");
		await expect(verifiedMicrosoftDraft({ routeId: route.id, payload: { ...payload, report: { ...payload.report, notes: `${payload.report.notes} edited` } } as never })).rejects.toThrow("no longer matches the report");
		await expect(verifiedMicrosoftDraft({ routeId: route.id, payload: { ...payload, target: { normalizedTarget: "other.example.com" } } as never })).rejects.toThrow("no longer matches its route");
		await expect(verifiedMicrosoftDraft({ routeId: route.id, payload: { ...payload, report: { ...payload.report, reference: "PS-000000000000-R1" } } as never })).rejects.toThrow("no longer matches the report");
		(await getDb()).update(abuseTargets).set({ observedUrls: [`https://${TARGET}/changed`] }).where(eq(abuseTargets.id, targetId)).run();
		await expect(verifiedMicrosoftDraft(context)).rejects.toThrow("no longer matches the report");
	});
});

describe("submitMicrosoftSubmission", () => {
	test("posts the portal's request unauthenticated; nothing else is sent", async () => {
		const { context, payload } = await readyContext();
		const fake = fakeFetch(json({ id: "MSRC-12345" }));
		const success = await submitMicrosoftSubmission(context, { fetch: fake.fetch, now: () => NOW });
		expect(success).toEqual({
			confirmationId: payload.report.reference,
			confirmationText: `Microsoft MSRC accepted the report (${payload.report.reference}, MSRC-12345)`,
			finalUrl: MICROSOFT_PROVIDER.formUrl,
			submittedTargets: [TARGET],
		});
		expect(fake.sent).toHaveLength(1);
		const { url, init } = fake.sent[0]!;
		expect(url).toBe("https://api.msrc.microsoft.com/report/v3.0/abuse");
		expect(init.method).toBe("POST");
		const headers = init.headers as Record<string, string>;
		expect(headers).toMatchObject({ "content-type": "application/json", origin: "https://msrc.microsoft.com", referer: "https://msrc.microsoft.com/" });
		expect(headers["request-id"]).toMatch(/^[0-9a-f-]{36}$/);
		expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("authorization");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(String(init.body))).toEqual({
			threatType: "URL",
			source: "CertPortalV2",
			incidentType: "Phishing",
			reporterName: "Phishing Support",
			reporterEmail: "support@phishing.support",
			reporterOrg: "Phishing Support",
			phoneNumber: "",
			urlList: [{ sourceUrl: `https://${TARGET}/signin` }],
			reportNotes: payload.report.notes,
			date: "2026-11-20",
			time: "11:02",
			timeZone: "+0000",
			anonymizeReport: false,
		});
	});

	test("a malware report files the Malware incident type", async () => {
		const { context } = await readyContext({ allegationCategory: "malware" });
		const fake = fakeFetch(json({}));
		await submitMicrosoftSubmission(context, { fetch: fake.fetch, now: () => NOW });
		expect(JSON.parse(String(fake.sent[0]!.init.body)).incidentType).toBe("Malware");
	});

	test("an answer without an id confirms with our reference", async () => {
		const { context, payload } = await readyContext();
		// The spec declares a bare 200 (no schema): any 2xx, with or without a body, is filed.
		const answers = [json({}), json(true), json(null), json("ok"), json({ id: "a b" }), new Response("", { status: 200 }), new Response(null, { status: 204 }), new Response("<html>ok</html>", { status: 200 }), new Response("{", { status: 202 })];
		for (const [index, answer] of answers.entries()) {
			const success = await submitMicrosoftSubmission(context, { fetch: fakeFetch(answer).fetch, now: () => NOW });
			expect(success, `answer ${index}`).toMatchObject({ confirmationId: payload.report.reference, confirmationText: `Microsoft MSRC accepted the report (${payload.report.reference})`, submittedTargets: [TARGET] });
		}
	});

	test("an id in the answer is recorded beside our reference, which stays the receipt", async () => {
		const { context, payload } = await readyContext();
		const success = await submitMicrosoftSubmission(context, { fetch: fakeFetch(json({ data: { caseId: "A1B2C3D4" } })).fetch, now: () => NOW });
		expect(success.confirmationId).toBe(payload.report.reference);
		expect(success.confirmationText).toContain("A1B2C3D4");
	});

	test("HTTP 400 means nothing was filed", async () => {
		const { context } = await readyContext();
		const error = await submitMicrosoftSubmission(context, { fetch: fakeFetch(json({ errors: { ReportNotes: ["too long"] } }, 400)).fetch, now: () => NOW }).catch((caught) => caught);
		expect(error).toBeInstanceOf(ProviderSubmissionRejectedError);
		expect(error.message).toContain("HTTP 400");
		expect(error.message).toContain("ReportNotes");
		expect(await submitMicrosoftSubmission(context, { fetch: fakeFetch(new Response("", { status: 400 })).fetch }).catch((caught) => caught)).toBeInstanceOf(ProviderSubmissionRejectedError);
	});

	test("every other failure is ambiguous: a plain error, never a rejection", async () => {
		const { context } = await readyContext();
		const cases: Array<[string, Response | Error]> = [
			["401", json({ message: "no" }, 401)],
			["403", json({ message: "Forbidden" }, 403)],
			["404", new Response("", { status: 404 })],
			["413", new Response("", { status: 413 })],
			["422", json({}, 422)],
			["429", json({ message: "duplicate" }, 429)],
			["500", json({ message: "boom" }, 500)],
			["502", new Response("<html>bad gateway</html>", { status: 502 })],
			["network", new TypeError("fetch failed")],
			["timeout", new DOMException("The operation timed out.", "TimeoutError")],
		];
		for (const [name, answer] of cases) {
			const error = await submitMicrosoftSubmission(context, { fetch: fakeFetch(answer).fetch, now: () => NOW }).catch((caught) => caught);
			expect(error, name).toBeInstanceOf(Error);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionRejectedError);
		}
	});

	test("the worker's deadline aborts the request", async () => {
		const { context } = await readyContext();
		const controller = new AbortController();
		const fetch = (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.aborted ? reject(init.signal!.reason) : init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
		const pending = submitMicrosoftSubmission({ ...context, signal: controller.signal }, { fetch, now: () => NOW });
		controller.abort(new Error("deadline"));
		await expect(pending).rejects.toThrow("deadline");
		expect(MICROSOFT_PROVIDER.timeoutMs).toBeGreaterThan(0);
	});

	test("a draft that no longer matches the report is never sent", async () => {
		const { context } = await readyContext();
		const fake = fakeFetch(json({}));
		await expect(submitMicrosoftSubmission({ ...context, payload: { ...context.payload, adapter: "other" } }, { fetch: fake.fetch })).rejects.toThrow("malformed");
		expect(fake.sent).toHaveLength(0);
	});
});

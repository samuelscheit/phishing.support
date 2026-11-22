import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../../db/test_helpers";
import { contactRoute } from "../../resolver/routes";
import { readyDraft, TARGET } from "../kit/testing";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { DIGITALOCEAN_PROVIDER as PROVIDER } from "./definition";
import { digitalOceanProvider } from "./index";
import { buildDigitalOceanSubmissionPayload, digitalOceanCampaignTarget, storedDigitalOceanSubmissionPayload, type DigitalOceanReportInput } from "./payload";
import { digitalOceanDraft, submissionFields, submitDigitalOceanSubmission } from "./submission";

useTemporaryDatabase();

const MAILBOX = "abuse@digitalocean.com";
const DESCRIPTION = "The page asks visitors for a password, sign-in details, a verification code, or identity details.";

const readyContext = (options: { target?: string; allegationCategory?: "phishing" | "malware"; observedUrls?: string[]; provenance?: Record<string, unknown>; legalBrandUrl?: string | null } = {}) => readyDraft({
	mailbox: MAILBOX,
	providerName: "DigitalOcean",
	...options,
}, digitalOceanDraft.prepare, storedDigitalOceanSubmissionPayload);

function fakeFetch(answer: () => Response | Error) {
	const sent: Array<{ url: string; init: RequestInit }> = [];
	const fetch = async (url: string, init: RequestInit) => {
		sent.push({ url, init });
		const value = answer();
		if (value instanceof Error) throw value;
		return value;
	};
	return { fetch, sent };
}

function input(overrides: Partial<DigitalOceanReportInput> = {}): DigitalOceanReportInput {
	return {
		target: TARGET,
		observedUrls: [`https://${TARGET}/signin`],
		description: DESCRIPTION,
		allegationCategory: "phishing",
		legalBrandUrl: "https://www.examplebank.com/",
		trackingId: "PS-8fc84cc01019-R7",
		caseUrl: "https://phishing.support/submissions/377486973465530391",
		capturedAt: new Date("2026-11-22T06:04:44.123Z"),
		...overrides,
	};
}

describe("registry", () => {
	test("the abuse mailbox resolves to the form provider, which mails XARF when the form refuses", async () => {
		const { getProviderSubmissionProviderForMailbox, listProviderSubmissionProviders } = await import("../submission_registry_default");
		expect(getProviderSubmissionProviderForMailbox(MAILBOX)?.definition.key).toBe("digitalocean");
		expect(getProviderSubmissionProviderForMailbox(" Abuse@DigitalOcean.com ")?.definition.key).toBe("digitalocean");
		expect(getProviderSubmissionProviderForMailbox("abuse@sub.digitalocean.com")).toBeUndefined();
		expect(contactRoute({ email: MAILBOX, providerName: "DigitalOcean", provenance: {}, snapshot: {} })).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "digitalocean", verifiedEmail: MAILBOX });
		expect(listProviderSubmissionProviders().filter((provider) => provider.definition.exactMailboxes.includes(MAILBOX)).map((provider) => provider.definition.key)).toEqual(["digitalocean"]);
		expect(PROVIDER.emailFallback).toEqual({ format: "xarf" });
		expect(PROVIDER.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(digitalOceanProvider.inboundMail).toMatchObject({ messageKind: "reply", senderDomains: ["digitalocean.com"] });
	});
});

describe("payload", () => {
	test("a domain target without a known address leaves the source IP out", () => {
		const payload = buildDigitalOceanSubmissionPayload(input())!;
		expect(payload.report).toMatchObject({
			trackingId: "PS-8fc84cc01019-R7",
			abuseType: "phishing",
			campaignTarget: "examplebank.com",
			evidenceUrl: `https://${TARGET}/signin`,
			sourceIp: null,
			observedAt: "2026-11-22T06:04:44.123Z",
		});
		const { details } = payload.report;
		expect(details.startsWith(`Reference: PS-8fc84cc01019-R7\n\nReported URLs:\n- https://${TARGET}/signin\n\n`)).toBeTrue();
		expect(details).toContain(`A suspected phishing site hosted on DigitalOcean is being reported for ${TARGET}.`);
		expect(details).toContain("Droplet or App Platform service");
		expect(details.endsWith("Case details and screenshots: https://phishing.support/submissions/377486973465530391")).toBeTrue();
		expect(storedDigitalOceanSubmissionPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
	});

	test("an origin server's address is the target: the domain's pages are its URLs", () => {
		const payload = buildDigitalOceanSubmissionPayload(input({ target: "164.90.1.2", sourceIp: "164.90.1.2", observedUrls: ["https://trk.example.run/gg?x=1", "https://trk.example.run/two", "https://other.example/x"] }))!;
		expect(payload.target.normalizedTarget).toBe("164.90.1.2");
		expect(payload.report).toMatchObject({ sourceIp: "164.90.1.2", evidenceUrl: "https://trk.example.run/gg?x=1" });
		expect(payload.report.details).toContain("- https://trk.example.run/two");
		expect(payload.report.details).not.toContain("other.example");
	});

	test("the campaign target is the brand's registrable domain, or Unknown", () => {
		expect(digitalOceanCampaignTarget("https://accounts.google.com/signin")).toBe("google.com");
		expect(digitalOceanCampaignTarget(null)).toBe("Unknown");
		expect(digitalOceanCampaignTarget("not a url")).toBe("Unknown");
	});

	test("nothing is drafted for an allegation the form has no type for, a bad reference or target, or no page", () => {
		expect(buildDigitalOceanSubmissionPayload(input({ allegationCategory: "fraud" }))).toBeUndefined();
		expect(buildDigitalOceanSubmissionPayload(input({ allegationCategory: undefined }))).toBeUndefined();
		expect(buildDigitalOceanSubmissionPayload(input({ trackingId: "PS-1" }))).toBeUndefined();
		expect(buildDigitalOceanSubmissionPayload(input({ target: "not a host" }))).toBeUndefined();
		expect(buildDigitalOceanSubmissionPayload(input({ target: "164.90.1.2", observedUrls: [] }))).toBeUndefined();
		expect(buildDigitalOceanSubmissionPayload(input({ description: "" }))).toBeUndefined();
		expect(buildDigitalOceanSubmissionPayload(input({ sourceIp: "not an ip" }))!.report.sourceIp).toBeNull();
	});

	test("a stored draft other than the builder's is refused", () => {
		const stored = () => JSON.parse(JSON.stringify(buildDigitalOceanSubmissionPayload(input({ sourceIp: "164.90.1.2" }))!)) as Record<string, any>;
		const mutations: Array<[string, (payload: Record<string, any>) => void]> = [
			["abuse type", (payload) => { payload.report.abuseType = "spam"; }],
			["source ip", (payload) => { payload.report.sourceIp = "nope"; }],
			["source ip missing", (payload) => { delete payload.report.sourceIp; }],
			["time not ISO", (payload) => { payload.report.observedAt = "2026-11-22 06:04"; }],
			["evidence url", (payload) => { payload.report.evidenceUrl = "login page"; }],
			["details without reference", (payload) => { payload.report.details = "hello"; }],
			["details too long", (payload) => { payload.report.details = `Reference: ${payload.report.trackingId}\n${"x".repeat(PROVIDER.detailsMaximumLength)}`; }],
			["campaign target empty", (payload) => { payload.report.campaignTarget = ""; }],
			["definition", (payload) => { payload.definition.version = "old"; }],
		];
		for (const [name, mutate] of mutations) {
			const payload = stored();
			mutate(payload);
			expect(storedDigitalOceanSubmissionPayload(payload), name).toBeUndefined();
		}
	});
});

describe("digitalOceanDraft", () => {
	test("prepares from the route, takes the resolver's hosting address, and verifies", async () => {
		const plain = await readyContext();
		expect(plain.payload.report.sourceIp).toBeNull();
		expect((await digitalOceanDraft.verify(plain.context)).payload).toEqual(plain.payload);
		const hosted = await readyContext({ provenance: { source: "domain_infrastructure_ip", originatingIp: "164.90.1.2", originatingDomain: TARGET, dnsResolution: { publicAddresses: ["164.90.1.2"] } } });
		expect(hosted.payload.report.sourceIp).toBe("164.90.1.2");
		expect(hosted.payload.report.details).toContain(`Hosting IP address: 164.90.1.2 (${TARGET} resolved to 164.90.1.2`);
		const malware = await readyContext({ allegationCategory: "malware" });
		expect(malware.payload.report.abuseType).toBe("malware");
		expect(malware.payload.report.details).toContain("A suspected malware");
	});

	test("a drifted draft is refused before anything is sent", async () => {
		const { context, payload } = await readyContext();
		await expect(digitalOceanDraft.verify({ ...context, payload: { ...payload, report: { ...payload.report, campaignTarget: "other.com" } } as never })).rejects.toThrow("no longer matches the report");
	});
});

describe("submitDigitalOceanSubmission", () => {
	test("posts the form's multipart request; 201 without a body is the receipt", async () => {
		const { context, payload } = await readyContext();
		const fake = fakeFetch(() => new Response(null, { status: 201 }));
		expect(await submitDigitalOceanSubmission(context, { fetch: fake.fetch })).toEqual({
			confirmationId: payload.report.trackingId,
			confirmationText: `DigitalOcean accepted the report (reference ${payload.report.trackingId})`,
			finalUrl: PROVIDER.formUrl,
			submittedTargets: [TARGET],
		});
		expect(fake.sent).toHaveLength(1);
		const { url, init } = fake.sent[0]!;
		expect(url).toBe("https://inbound.digitalocean.com/contact_forms/abuse_reports");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ accept: "application/json, text/plain, */*", origin: "https://www.digitalocean.com", referer: "https://www.digitalocean.com/" });
		expect(init.signal).toBeInstanceOf(AbortSignal);
		const form = init.body as FormData;
		expect([...form.entries()]).toEqual(submissionFields(payload));
		expect(form.get("abuse_report[source_ip]")).toBeNull();
		expect(Object.fromEntries(form.entries())).toMatchObject({
			"abuse_report[reporter_name]": "Phishing Support",
			"abuse_report[email]": "support@phishing.support",
			"abuse_report[phishing_campaign_target]": "examplebank.com",
			"abuse_report[evidence_urls]": `https://${TARGET}/signin`,
			"abuse_report[timezone]": "+00:00",
			"abuse_report[additional_information]": payload.report.details,
			"abuse_report[abuse_type]": "phishing",
			"abuse_report[affirmation_check]": "1",
		});
		expect(form.get("abuse_report[date]")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(form.get("abuse_report[time]")).toMatch(/^\d{2}:\d{2}$/);
	});

	test("the request fields: a known address, and the malware form's evidence instead of a campaign target", () => {
		const phishing = buildDigitalOceanSubmissionPayload(input({ sourceIp: "2604:a880::1" }))!;
		expect(submissionFields(phishing)).toEqual([
			["abuse_report[reporter_name]", "Phishing Support"],
			["abuse_report[email]", "support@phishing.support"],
			["abuse_report[phishing_campaign_target]", "examplebank.com"],
			["abuse_report[evidence_urls]", `https://${TARGET}/signin`],
			["abuse_report[source_ip]", "2604:a880::1"],
			["abuse_report[date]", "2026-11-22"],
			["abuse_report[time]", "06:04"],
			["abuse_report[timezone]", "+00:00"],
			["abuse_report[additional_information]", phishing.report.details],
			["abuse_report[abuse_type]", "phishing"],
			["abuse_report[affirmation_check]", "1"],
		]);
		const malware = buildDigitalOceanSubmissionPayload(input({ allegationCategory: "malware" }))!;
		const fields = Object.fromEntries(submissionFields(malware));
		expect(fields["abuse_report[phishing_campaign_target]"]).toBeUndefined();
		expect(fields["abuse_report[abuse_evidence]"]).toBe(malware.report.details);
		expect(fields["abuse_report[abuse_type]"]).toBe("malware");
	});

	test("422 is a refusal; anything else but 2xx, or no answer, is ambiguous", async () => {
		const { context } = await readyContext();
		await expect(submitDigitalOceanSubmission(context, { fetch: fakeFetch(() => new Response("", { status: 422 })).fetch })).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
		for (const answer of [() => new Response("oops", { status: 500 }), () => new Response("", { status: 429 }), () => new Error("socket hang up")]) {
			const error = await submitDigitalOceanSubmission(context, { fetch: fakeFetch(answer).fetch }).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(ProviderSubmissionRejectedError);
		}
	});
});

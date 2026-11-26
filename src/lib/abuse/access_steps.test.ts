import { describe, expect, test } from "bun:test";
import type { WebsiteSubmissionData } from "../db/schema";
import type { WebsiteAccessStep, WebsiteNavigationHop, WebsiteRoute } from "../website/types";
import { buildWebsiteReportEvidence } from "../website/analysis/classification";
import { websiteAccessSteps } from "./access_steps";
import { createAbuseEmailDraft, readVerifiedEmailDraft, verifiedEmailProviderPayload } from "./mail/draft";
import { buildProviderReportNarrative } from "./providers/kit/report_payload";
import { buildCloudflareReportPayload } from "./providers/cloudflare/report";
import { makeTencentExplanation } from "./providers/tencent/payload";
import { makeNetcraftReason } from "./providers/netcraft/payload";
import { buildGenericProviderFormTask } from "./portal/form_task";
import { withoutAccessSteps } from "../website/visit/access_steps_text";
import { PRESERVATION_REQUEST_SHORT } from "./preservation";

const at = "2026-11-17T10:00:00.000Z";
const login = "https://webmail-verify.com/login";
const verify = "https://webmail-verify.com/verify";
const inbox = "https://webmail-verify.com/inbox";
const caseUrl = "https://phishing.support/submissions/352185586284498946";

/** The visit signed in with our values, then a person who took over typed the code the site mailed. */
const steps: WebsiteAccessStep[] = [
	{ actor: "agent", pageUrl: login, action: "type", field: "Email", value: "jane.doe@mail.example", at },
	{ actor: "agent", pageUrl: login, action: "type", field: "Password", value: "Kx9!qL2#", synthetic: "password", at },
	{ actor: "agent", pageUrl: login, action: "click", field: "Sign in", at },
	{ actor: "human", pageUrl: verify, action: "type", field: "One-time code", value: "481516", at },
	{ actor: "human", pageUrl: verify, action: "click", field: "Verify", at },
];

const hop = (index: number, url: string, extra: Partial<WebsiteNavigationHop> = {}): WebsiteNavigationHop => ({ index, url, hostname: new URL(url).hostname, status: 200, contentCaptured: false, ...extra });

describe("the access steps of a case's report", () => {
	test("come from the walk that reached the report's URLs, else from the route the verdict rests on", () => {
		const route = (url: string, accessSteps: WebsiteAccessStep[]): WebsiteRoute => ({
			hops: [hop(0, url, { contentCaptured: true })],
			visit: { outcome: "completed", actions: [], accessSteps, dataSent: [], downloadFailures: [] },
		});
		const website: WebsiteSubmissionData = { url: login, routes: [route("https://other.example/", []), route(inbox, steps)], analyzedRoute: 0 };
		expect(websiteAccessSteps(website, [inbox])).toEqual(steps);
		expect(websiteAccessSteps(website, ["https://unrelated.example/"])).toEqual([]);
		expect(websiteAccessSteps({ ...website, analyzedRoute: 1 }, ["https://unrelated.example/"])).toEqual(steps);
		expect(websiteAccessSteps({ url: login }, [inbox])).toEqual([]);
		// A walk without a visit record has no steps.
		expect(websiteAccessSteps({ url: login, routes: [{ hops: [hop(0, inbox)] }] }, [inbox])).toEqual([]);
	});

	test("the description states them after the gate, in place of the pages the visit passed", () => {
		const hops = [hop(0, login, { visitorStep: { submitted: ["email", "password"] } }), hop(1, inbox, { contentCaptured: true })];
		const classification = { finding: "phishing" as const, phishingBasis: "credential_theft" as const };
		const without = buildWebsiteReportEvidence(classification, { navigationHops: hops, caseUrl });
		expect(without).toContain(`Visitors reach the page through the site's own earlier pages: ${login}, where our visit entered a synthetic email address and password and submitted.`);
		const text = buildWebsiteReportEvidence(classification, { navigationHops: hops, caseUrl, accessSteps: steps });
		expect(text).not.toContain("Visitors reach the page through");
		expect(text).toContain([
			"How to reach the content (values were made up by us, or typed by a person who took over our browser):",
			`1. Open ${login}`,
			"2. In \"Email\" enter \"jane.doe@mail.example\"",
			"3. In \"Password\" enter \"Kx9!qL2#\" (our made-up password)",
			"4. Click \"Sign in\"",
			`5. Continue on ${verify}`,
			"6. In \"One-time code\" enter \"481516\" [by a person]",
			"7. Click \"Verify\" [by a person]",
		].join("\n"));
		// Steps that only opened pages say nothing more than the pages passed.
		expect(buildWebsiteReportEvidence(classification, { navigationHops: hops, caseUrl, accessSteps: [{ actor: "agent", pageUrl: login, action: "open", value: login, at }] })).toBe(without);
	});

	const description = buildWebsiteReportEvidence({ finding: "phishing", phishingBasis: "credential_theft", impersonatedBrand: { name: "Webmail", officialUrl: "https://www.gmx.net" } }, {
		navigationHops: [hop(0, login), hop(1, inbox, { contentCaptured: true })],
		caseUrl,
		accessSteps: steps,
	});

	test("a provider's narrative carries them in a large field, a pointer to the case page in a small one", () => {
		const narrative = (maximumLength: number, accessSteps = steps) => buildProviderReportNarrative({ provider: "generic", target: "webmail-verify.com", observedUrls: [inbox], description, legalBrandUrl: "https://www.gmx.net", accessSteps, caseUrl, maximumLength });
		const large = narrative(3_000)!;
		expect(large).toContain(`How to reach the content (values were made up by us, or typed by a person who took over our browser): 1. Open ${login} 2. In "Email" enter "jane.doe@mail.example"`);
		expect(large).toContain("7. Click \"Verify\" [by a person]");
		expect(large).not.toContain("\n");
		// Before the brand reference.
		expect(large.indexOf("How to reach")).toBeLessThan(large.indexOf("https://www.gmx.net"));
		const small = narrative(1_000)!;
		expect(small).not.toContain("How to reach");
		expect(small).toContain(`The content shows only after entering values in the site's forms; the steps to reach it are listed at ${caseUrl}.`);
		expect(small.length).toBeLessThanOrEqual(1_000);
		// Steps beyond the room: middle steps give way to the case page (after the preservation request did).
		const many = [...steps, ...Array.from({ length: 20 }, (_, index): WebsiteAccessStep => ({ actor: "agent", pageUrl: inbox, action: "click", field: `Folder ${index}`, at }))];
		const full = narrative(10_000, many)!;
		const room = full.length - PRESERVATION_REQUEST_SHORT.length - 60;
		const medium = narrative(room, many)!;
		expect(medium.length).toBeLessThanOrEqual(room);
		expect(medium).toContain("Click \"Folder 19\"");
		expect(medium).toMatch(/… \d+ more steps? …/);
		expect(medium).toContain(`All steps: ${caseUrl}`);
		// A field with no room for anything else drops the steps, never the allegation.
		const tiny = narrative(200)!;
		expect(tiny.length).toBeLessThanOrEqual(200);
		expect(tiny).not.toContain("How to reach");
		// Without steps, the narrative is what it was.
		expect(buildProviderReportNarrative({ provider: "generic", target: "webmail-verify.com", observedUrls: [inbox], description: withoutAccessSteps(description), maximumLength: 3_000 }))
			.toBe(buildProviderReportNarrative({ provider: "generic", target: "webmail-verify.com", observedUrls: [inbox], description, maximumLength: 3_000 }));
	});

	test("the small provider forms get the pointer, the large ones the steps", () => {
		const tencent = makeTencentExplanation({ target: "webmail-verify.com", observedUrl: inbox, description, accessSteps: steps, caseUrl })!;
		expect(tencent.length).toBeLessThanOrEqual(400);
		expect(tencent).not.toContain("How to reach");
		const netcraft = makeNetcraftReason({ target: "webmail-verify.com", observedUrls: [inbox], description, accessSteps: steps, caseUrl })!;
		expect(netcraft).toContain("6. In \"One-time code\" enter \"481516\" [by a person]");
	});

	test("Cloudflare's justification states them before the evidence, within its limit", () => {
		const payload = buildCloudflareReportPayload({ target: "webmail-verify.com", observedUrl: inbox, description, allegationCategory: "phishing", accessSteps: steps, caseUrl });
		expect(payload.justification.length).toBeLessThanOrEqual(3_000);
		expect(payload.justification).toContain(`\n\nHow to reach the content (values were made up by us, or typed by a person who took over our browser):\n1. Open ${login}\n`);
		expect(payload.justification.indexOf("How to reach")).toBeLessThan(payload.justification.indexOf("Why this is phishing:"));
		// The evidence below them is not the steps again.
		expect(payload.justification.split("How to reach")).toHaveLength(2);
		const many = Array.from({ length: 80 }, (_, index): WebsiteAccessStep => ({ actor: "agent", pageUrl: login, action: "click", field: `Next ${index}`, at }));
		const long = buildCloudflareReportPayload({ target: "webmail-verify.com", observedUrl: inbox, description, accessSteps: many, caseUrl }).justification;
		expect(long.length).toBeLessThanOrEqual(3_000);
		expect(long).toContain(`All steps: ${caseUrl}`);
		expect(long).toContain("Why this is phishing:");
	});

	test("the generic portal's description carries them", () => {
		const task = buildGenericProviderFormTask({
			entryUrl: "https://abuse.provider.example.com/report",
			allowedDomains: ["provider.example.com"],
			target: "webmail-verify.com",
			allegationCategory: "phishing",
			description,
			observedUrls: [inbox],
			reporter: { name: "Phishing Support", organization: "Phishing Support", website: "https://phishing.support", email: "support@phishing.support" },
			observedAt: new Date(at),
			evidence: [],
			accessSteps: steps,
			caseUrl,
		});
		expect(task.goal).toContain("In \\\"One-time code\\\" enter \\\"481516\\\" [by a person]");
	});

	test("the mail states them in its own section, outside the model's summary, and the sender accepts it", async () => {
		const report = { id: 373043025057681485n, allegationCategory: "phishing", submissionId: 352185586284498946n, reporterName: null, reporterContactEmail: null, description, legalBrandUrl: "https://www.gmx.net" };
		const target = { normalizedTarget: "webmail-verify.com", observedUrls: [inbox] };
		const route = { createdAt: new Date(at), providerDisplayName: "Abuse team", resolverProvenance: { email: "abuse@hostinger.com", source: "domain_rdap" }, resolutionSnapshot: {} };
		let summarized = "";
		const draft = await createAbuseEmailDraft({ report, target, route, recipient: "abuse@hostinger.com", accessSteps: steps }, {
			generateSummary: async (input) => {
				summarized = input.description;
				return "The page imitates a webmail sign-in and asks for a mailed code.";
			},
		});
		// The model never sees the steps; they are ours to state.
		expect(summarized).not.toContain("How to reach");
		const [details, rest] = draft.body.split("\n\nHow to reach the content");
		expect(details).toContain(`Observed URLs:\n- ${inbox}`);
		expect(rest).toStartWith(" (values were made up by us, or typed by a person who took over our browser):\n1. Open https://webmail-verify.com/login\n");
		expect(rest!.indexOf("7. Click \"Verify\" [by a person]")).toBeLessThan(rest!.indexOf("Evidence summary:\nThe page imitates a webmail sign-in"));
		expect(draft.body.length).toBeLessThanOrEqual(5_000);

		// The draft as the worker stores it reads back: the steps are no copy of the description, their pages are approved links.
		const payload = verifiedEmailProviderPayload({ target: target.normalizedTarget, observedUrls: target.observedUrls, recipient: "abuse@hostinger.com", email: draft });
		const allowed = ["https://phishing.support", inbox, "https://www.gmx.net", caseUrl];
		const read = (allowedUrls: string[]) => readVerifiedEmailDraft(payload, { recipient: "abuse@hostinger.com", description, target: target.normalizedTarget, observedUrls: target.observedUrls, allowedUrls });
		expect(read([...allowed, login, verify])).toEqual(draft);
		// A page the steps name that the worker did not approve stops the mail.
		expect(read(allowed)).toBeUndefined();

		// Without steps the mail has no such section.
		const plain = await createAbuseEmailDraft({ report, target, route, recipient: "abuse@hostinger.com" }, { generateSummary: async () => "x" });
		expect(plain.body).not.toContain("How to reach");
	});
});

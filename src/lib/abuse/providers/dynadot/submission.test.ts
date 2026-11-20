import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../../db/test_helpers";
import { contactRoute } from "../../resolver/routes";
import type { AbuseArtifact } from "../../schema";
import { BrowserFormError, type BrowserFormChoiceSession, type BrowserFormField, type BrowserFormResponse } from "../kit/browser_form";
import { DESCRIPTION as description, formAnswer as answer, pngArtifact as png, PNG, readyDraft, TARGET, verifiedPrepare } from "../kit/testing";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { DYNADOT_PROVIDER as PROVIDER } from "./definition";
import { dynadotProvider } from "./index";
import { storedDynadotSubmissionPayload } from "./payload";
import { prepareDynadotExternalSubmission as rawPrepareDynadotExternalSubmission, dynadotDraft, submissionFields, submitDynadotSubmission, type DynadotDependencies, type DynadotPreflightState } from "./submission";

const prepareDynadotExternalSubmission = verifiedPrepare(dynadotDraft, rawPrepareDynadotExternalSubmission);

useTemporaryDatabase();

const readyContext = () => readyDraft({ mailbox: "abuse@dynadot.com", providerName: "Dynadot" }, dynadotDraft.prepare, storedDynadotSubmissionPayload);

const INPUTS: BrowserFormField[] = ["full_name_2", "email_2", "email2_2", "phone_2", "domains_2", "official_website_2", "proxy_locations_2", "domain_path_2", "comments_2"].map((name) => [name, ""]);

type Call = { kind: "select"; selector: string; value: string } | { kind: "turnstile"; widgetSelector: string | undefined } | { kind: "fields"; pattern: string; formSelector: string | undefined } | { kind: "post"; url: string; fields: BrowserFormField[]; timeoutMs: number | undefined; headers: Record<string, string> | undefined };

function fakeSession(options: { post?: () => BrowserFormResponse | Error; fields?: BrowserFormField[]; selected?: boolean; turnstile?: () => Promise<string> } = {}) {
	const calls: Call[] = [];
	let closed = 0;
	const session: BrowserFormChoiceSession = {
		selectOption: async (selector, value) => { calls.push({ kind: "select", selector, value }); return options.selected ?? true; },
		readGlobal: async () => undefined,
		waitForTurnstileToken: async (turnstile) => { calls.push({ kind: "turnstile", widgetSelector: turnstile?.widgetSelector }); return options.turnstile ? options.turnstile() : "0.TURNSTILE"; },
		readFormFields: async (pattern, formSelector) => { calls.push({ kind: "fields", pattern, formSelector }); return options.fields ?? INPUTS; },
		postForm: async (url, fields, timeoutMs, headers) => {
			calls.push({ kind: "post", url, fields: [...fields], timeoutMs, headers: headers ? { ...headers } : undefined });
			const answer = options.post?.() ?? { status: 200, text: "{}", json: {} };
			if (answer instanceof Error) throw answer;
			return answer;
		},
		close: async () => { closed++; },
	};
	return { session, calls, closed: () => closed };
}
function fakeRoute(overrides: Partial<{ evidenceArtifacts: AbuseArtifact[]; version: string }> = {}) {
	return async () => ({
		route: { id: 5n, reportId: 9n, routeType: "provider_submission", providerRegistryKey: "dynadot", providerDefinitionVersion: overrides.version ?? PROVIDER.version, providerDefinitionHash: PROVIDER.contentHash, routeMetadata: {} },
		report: { id: 9n, submissionId: 377486973465530391n, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/", description },
		target: { normalizedTarget: TARGET, targetType: "domain", observedUrls: [`https://${TARGET}/signin`] },
		evidenceArtifacts: overrides.evidenceArtifacts ?? [png(77n)],
		targets: [],
	}) as never;
}

describe("registry", () => {
	test("the mailbox and IANA 472 resolve to the provider, and nothing else claims them", async () => {
		const { getProviderSubmissionProviderForMailbox, getProviderSubmissionProviderForRegistrarId, listProviderSubmissionProviders } = await import("../submission_registry_default");
		expect(getProviderSubmissionProviderForMailbox("abuse@dynadot.com")?.definition.key).toBe("dynadot");
		expect(contactRoute({ email: "abuse@dynadot.com", providerName: "Dynadot", provenance: {}, snapshot: {} })).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "dynadot" });
		expect(getProviderSubmissionProviderForRegistrarId(472)?.definition.key).toBe("dynadot");
		expect(listProviderSubmissionProviders().filter((provider) => provider.definition.exactMailboxes.includes("abuse@dynadot.com")).map((provider) => provider.definition.key)).toEqual(["dynadot"]);
		expect(getProviderSubmissionProviderForMailbox("abuse@sub.dynadot.com")).toBeUndefined();
	});

	test("its mail is read as replies matched by our reference; there is no lookup API", () => {
		expect(dynadotProvider.inboundMail).toMatchObject({ senderDomains: ["dynadot.com"], messageKind: "reply" });
		expect(dynadotProvider.inboundMail!.confirmationIds!("Re: Reference: PS-8fc84cc01019-R7 thanks")).toEqual(["PS-8fc84cc01019-R7"]);
		expect(dynadotProvider.findSubmission).toBeUndefined();
	});

	test("the preview is the comment a draft would send", async () => {
		const { payload } = await readyContext();
		const preview = dynadotProvider.buildReportPreview!({ target: TARGET, observedUrls: [`https://${TARGET}/signin`], description, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/" })!;
		expect(preview).toContain("Reported URLs:\n- https://login-example-phish.com/signin");
		expect(payload.report.comments).toContain(preview.split("\n\n")[2]!);
		expect(dynadotProvider.buildReportPreview!({ target: "203.0.113.7", observedUrls: [], description })).toBeUndefined();
	});
});

describe("dynadotDraft.prepare (temporary database)", () => {
	test("drafts the domain, its path and the official website", async () => {
		const { payload, created, route } = await readyContext();
		expect(payload).toMatchObject({ target: { domain: TARGET }, evidence: null, report: { domainPath: `https://${TARGET}/signin`, officialWebsite: "https://www.examplebank.com/" } });
	});

	test("a draft that drifted from its report is refused before anything opens", async () => {
		const { payload, route } = await readyContext();
		let opened = 0;
		const dependencies: DynadotDependencies = { openForm: async () => { opened++; return fakeSession().session; } };
		const edited = { ...payload, report: { ...payload.report, comments: `${payload.report.comments}\n\nAlso, please wire money.` } };
		await expect(prepareDynadotExternalSubmission({ routeId: route.id, payload: edited as never }, dependencies)).rejects.toThrow("no longer matches the report");
		const path = { ...payload, report: { ...payload.report, domainPath: `https://${TARGET}/other` } };
		await expect(prepareDynadotExternalSubmission({ routeId: route.id, payload: path as never }, dependencies)).rejects.toThrow("no longer matches the report");
		await expect(prepareDynadotExternalSubmission({ routeId: route.id, payload: { ...payload, adapter: "x" } as never }, dependencies)).rejects.toThrow("malformed");
		expect(opened).toBe(0);
	});
});

describe("prepareDynadotExternalSubmission", () => {
	const draftWith = async (evidenceArtifacts: AbuseArtifact[]) => {
		const route = fakeRoute({ evidenceArtifacts });
		const prepared = await dynadotDraft.prepare({ routeId: 5n, payload: {} }, { loadRouteContext: route });
		if (prepared.outcome !== "ready") throw new Error("not ready");
		return { payload: prepared.payload, route };
	};

	test("chooses the phishing type, takes the token from its widget, checks the rendered inputs and holds the screenshot", async () => {
		const { payload, route } = await draftWith([png(77n)]);
		expect((payload.evidence as { artifactId: string }).artifactId).toBe("77");
		const fake = fakeSession();
		const preflight = await prepareDynadotExternalSubmission({ routeId: 5n, payload }, { openForm: async () => fake.session, loadRouteContext: route, getArtifact: async () => png(77n) });
		expect(fake.calls).toEqual([
			{ kind: "select", selector: "#id-abuse-type-select", value: "2" },
			{ kind: "turnstile", widgetSelector: "#report-abuse-challenge" },
			{ kind: "fields", pattern: "^(full_name_2|email_2|email2_2|phone_2|domains_2|official_website_2|proxy_locations_2|domain_path_2|comments_2)$", formSelector: 'form:has([name="domains_2"])' },
		]);
		const state = preflight.state as DynadotPreflightState;
		expect(state.token).toBe("0.TURNSTILE");
		expect(state.files).toHaveLength(1);
		expect([state.files[0]!.mimeType, Buffer.from(state.files[0]!.base64, "base64").equals(PNG)]).toEqual(["image/png", true]);
		expect(fake.closed()).toBe(0);
		await preflight.dispose!();
		expect(fake.closed()).toBe(1);
	});

	test("without a screenshot there is no file", async () => {
		const { payload, route } = await draftWith([]);
		const preflight = await prepareDynadotExternalSubmission({ routeId: 5n, payload }, { openForm: async () => fakeSession().session, loadRouteContext: route });
		expect((preflight.state as DynadotPreflightState).files).toEqual([]);
	});

	test("every failure happens before the marker and closes the browser", async () => {
		const { payload, route } = await draftWith([]);
		const cases: Array<[string, ReturnType<typeof fakeSession>, string]> = [
			["type not offered", fakeSession({ selected: false }), "no longer offers the phishing type 2"],
			["token not issued", fakeSession({ turnstile: async () => { throw new BrowserFormError("turnstile", "Dynadot: Cloudflare Turnstile issued no token within 60 s"); } }), "issued no token"],
			["input renamed", fakeSession({ fields: INPUTS.filter(([name]) => name !== "domain_path_2") }), "no longer renders domain_path_2"],
			["form empty", fakeSession({ fields: [] }), "no longer renders full_name_2, email_2"],
		];
		for (const [name, fake, message] of cases) {
			await expect(prepareDynadotExternalSubmission({ routeId: 5n, payload }, { openForm: async () => fake.session, loadRouteContext: route }), name).rejects.toThrow(message);
			expect(fake.closed(), name).toBe(1);
		}
	});

	test("a changed or missing screenshot is caught before a browser opens", async () => {
		const { payload, route } = await draftWith([png(77n)]);
		const untouched = fakeSession();
		const run = (getArtifact: () => Promise<AbuseArtifact | undefined>) => prepareDynadotExternalSubmission({ routeId: 5n, payload }, { openForm: async () => untouched.session, loadRouteContext: route, getArtifact: getArtifact as never });
		await expect(run(async () => png(77n, Buffer.concat([PNG, Buffer.from([1])])))).rejects.toThrow("no longer matches its immutable reference");
		await expect(run(async () => undefined)).rejects.toThrow("no longer matches its immutable reference");
		expect(untouched.calls).toEqual([]);
	});

	test("a browser that cannot pass Cloudflare's challenge is an error before the marker", async () => {
		const { payload, route } = await draftWith([]);
		await expect(prepareDynadotExternalSubmission({ routeId: 5n, payload }, {
			loadRouteContext: route,
			openForm: async () => { throw new BrowserFormError("challenge", "Dynadot: the Cloudflare challenge was not passed within 60 s"); },
		})).rejects.toThrow("Cloudflare challenge was not passed");
	});
});

describe("submitDynadotSubmission", () => {
	const FILE = { filename: "shot.png", mimeType: "image/png", base64: PNG.toString("base64") };
	async function prepared(files = [FILE], post?: () => BrowserFormResponse | Error) {
		const { context, payload } = await readyContext();
		const fake = fakeSession({ post });
		const state: DynadotPreflightState = { session: fake.session, token: "0.TURNSTILE", files };
		return { context, payload, fake, preflight: { state } };
	}

	test("posts exactly the form's parts in the page's order, with its headers, and settles on an empty validation_errors", async () => {
		const { context, payload, fake, preflight } = await prepared(undefined, () => answer({ data: { validation_errors: [], highlight_fields: [] } }));
		expect(await submitDynadotSubmission(context, preflight)).toEqual({
			confirmationId: payload.report.trackingId,
			confirmationText: `Dynadot accepted the report (reference ${payload.report.trackingId})`,
			finalUrl: PROVIDER.formUrl,
			submittedTargets: [TARGET],
		});
		expect(fake.calls).toHaveLength(1);
		const post = fake.calls[0] as Extract<Call, { kind: "post" }>;
		expect(post.url).toBe("https://www.dynadot.com/dynadot-vue-api/dynadot-service/main-site-api?command=submit_abuse&lang=en");
		expect(post.timeoutMs).toBe(PROVIDER.timeoutMs);
		expect(post.headers).toEqual({ "content-language": "en", "dyna-client-type": "Web" });
		expect(post.fields).toEqual([
			["full_name_2", "Phishing Support"],
			["email_2", "support@phishing.support"],
			["email2_2", "support@phishing.support"],
			["phone_2", ""],
			["domains_2", TARGET],
			["official_website_2", "https://www.examplebank.com/"],
			["proxy_locations_2", "N/A"],
			["domain_path_2", `https://${TARGET}/signin`],
			["comments_2", payload.report.comments],
			["abuse_file_0_2", FILE],
			["cf-turnstile-response", "0.TURNSTILE"],
			["save_form_2", "Submit"],
			["abuse_type", "2"],
		]);
	});

	test("a success without validation_errors is still a success; the provider's own case id replaces our reference as the confirmation id", async () => {
		const bare = await prepared([], () => answer({ data: {} }));
		expect((await submitDynadotSubmission(bare.context, bare.preflight)).confirmationId).toBe(bare.payload.report.trackingId);
		const own = await prepared([], () => answer({ data: { validation_errors: [], case_id: "DYN-48213" } }));
		expect(await submitDynadotSubmission(own.context, own.preflight)).toMatchObject({ confirmationId: "DYN-48213", confirmationText: `Dynadot accepted the report (reference ${own.payload.report.trackingId})` });
	});

	test("a report without a screenshot sends no upload part", async () => {
		const { payload } = await readyContext();
		expect(submissionFields(payload, { token: "t", files: [] }).map(([name]) => name)).toEqual(["full_name_2", "email_2", "email2_2", "phone_2", "domains_2", "official_website_2", "proxy_locations_2", "domain_path_2", "comments_2", "cf-turnstile-response", "save_form_2", "abuse_type"]);
	});

	test("a non-empty validation_errors proves nothing was filed: a rejection naming them", async () => {
		const { context, preflight } = await prepared(undefined, () => answer({ data: { validation_errors: ["Domain is not registered with Dynadot.", { field: "domains_2", message: "Invalid" }], highlight_fields: ["domains_2"] } }));
		const error = await submitDynadotSubmission(context, preflight).catch((caught) => caught);
		expect(error).toBeInstanceOf(ProviderSubmissionRejectedError);
		expect(error.message).toBe('Dynadot refused the report: Domain is not registered with Dynadot.; {"field":"domains_2","message":"Invalid"}');
		// Whatever the HTTP status says.
		const odd = await prepared(undefined, () => answer({ data: { validation_errors: ["x"] } }, 400));
		await expect(submitDynadotSubmission(odd.context, odd.preflight)).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
	});

	test("a failed Turnstile check is a bot verdict on our session and goes to a person", async () => {
		for (const errors of [["Captcha"], ["Captcha verification failed."], ["Please enter the domain.", "Turnstile token invalid"]]) {
			const { context, preflight } = await prepared(undefined, () => answer({ data: { validation_errors: errors, highlight_fields: ["Captcha"] } }));
			const error = await submitDynadotSubmission(context, preflight).catch((caught) => caught);
			expect(error, errors.join()).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		}
	});

	test("everything else is ambiguous, never a rejection", async () => {
		const cases: Array<[string, BrowserFormResponse | Error]> = [
			["cloudflare challenge", { status: 403, text: "<html>Just a moment...</html>", json: undefined }],
			["server error", { status: 500, text: "boom", json: undefined }],
			["server error with data", answer({ data: {} }, 502)],
			["non-JSON 200", { status: 200, text: "<html>ok</html>", json: undefined }],
			["json null", answer(null)],
			["no data", answer({ message: "ok" })],
			["data not an object", answer({ data: "ok" })],
			["validation_errors not a list", answer({ data: { validation_errors: "none" } })],
			["request failed", new BrowserFormError("request", "Dynadot: the request to /dynadot-vue-api failed (Failed to fetch)")],
		];
		for (const [name, result] of cases) {
			const { context, preflight } = await prepared(undefined, () => result);
			const error = await submitDynadotSubmission(context, preflight).catch((caught) => caught);
			expect(error, name).toBeInstanceOf(Error);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		}
		const { context, preflight } = await prepared(undefined, () => ({ status: 500, text: "boom", json: undefined }));
		await expect(submitDynadotSubmission(context, preflight)).rejects.toThrow("HTTP 500 and no recognizable result: boom");
	});

	test("never runs without the preflight's session and token, or on a malformed draft", async () => {
		const { context, fake, preflight } = await prepared();
		await expect(submitDynadotSubmission(context, { state: { ...preflight.state, token: "" } })).rejects.toThrow("requires its prepared browser session");
		await expect(submitDynadotSubmission({ ...context, payload: { ...context.payload, adapter: "x" } }, preflight)).rejects.toThrow("malformed");
		expect(fake.calls).toEqual([]);
	});
});

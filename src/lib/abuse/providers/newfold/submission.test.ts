import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../../db/test_helpers";
import { contactRoute } from "../../resolver/routes";
import type { AbuseArtifact } from "../../schema";
import { BrowserFormError, type BrowserFormField, type BrowserFormResponse } from "../kit/browser_form";
import { DESCRIPTION as description, pngArtifact as png, PNG, readyDraft, TARGET, verifiedPrepare } from "../kit/testing";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { NEWFOLD_PROVIDER as PROVIDER } from "./definition";
import { newfoldProvider } from "./index";
import { storedNewfoldSubmissionPayload } from "./payload";
import { leadFields, prepareNewfoldExternalSubmission as rawPrepareNewfoldExternalSubmission, newfoldDraft, submitNewfoldSubmission, type NewfoldDependencies, type NewfoldPreflightState } from "./submission";

const prepareNewfoldExternalSubmission = verifiedPrepare(newfoldDraft, rawPrepareNewfoldExternalSubmission);

useTemporaryDatabase();

const readyContext = (mailbox = "abuse@bluehost.com") => readyDraft({ mailbox, providerName: "Newfold" }, newfoldDraft.prepare, storedNewfoldSubmissionPayload);

const HIDDEN: BrowserFormField[] = PROVIDER.hiddenFields.map(([name, value]) => [name, value]);

type Call =
	| { kind: "fields"; pattern: string }
	| { kind: "captcha"; captcha: string }
	| { kind: "evaluate"; argument: unknown }
	| { kind: "post"; url: string; fields: BrowserFormField[]; timeoutMs: number | undefined };

/** A form session whose solver hands out `captcha()` as the reCAPTCHA token (or fails with it). */
function fakeSession(options: { post?: () => BrowserFormResponse | Error; rendered?: BrowserFormField[]; captcha?: () => Promise<string> } = {}) {
	const calls: Call[] = [];
	let closed = 0;
	const session = {
		readGlobal: async () => undefined,
		waitForCaptchaToken: async (captcha: string) => { calls.push({ kind: "captcha", captcha }); return (options.captcha ?? (async () => "03AFcWeA-TOKEN"))(); },
		readFormFields: async (pattern: string) => { calls.push({ kind: "fields", pattern }); return options.rendered ?? HIDDEN; },
		evaluate: async (_fn: unknown, argument: unknown) => { calls.push({ kind: "evaluate", argument }); return true; },
		postForm: async (url: string, fields: readonly BrowserFormField[], timeoutMs?: number) => {
			calls.push({ kind: "post", url, fields: [...fields], timeoutMs });
			const answer = options.post?.() ?? THANK_YOU;
			if (answer instanceof Error) throw answer;
			return answer;
		},
		close: async () => { closed++; },
	};
	return { session: session as never, calls, closed: () => closed };
}
const THANK_YOU: BrowserFormResponse = { status: 200, text: "<html>Thank you for submitting an 'Abuse' form</html>", json: undefined, url: "https://www.newfold.com/thank-you" };
const page = (status: number, text: string, url: string = PROVIDER.leadUrl): BrowserFormResponse => ({ status, text, json: undefined, url });

function fakeRoute(overrides: Partial<{ evidenceArtifacts: AbuseArtifact[]; version: string; verifiedEmail: string; resolverProvenance: unknown }> = {}) {
	return async () => ({
		route: { id: 5n, reportId: 9n, routeType: "provider_submission", providerRegistryKey: "newfold", providerDefinitionVersion: overrides.version ?? PROVIDER.version, providerDefinitionHash: PROVIDER.contentHash, routeMetadata: {}, verifiedEmail: overrides.verifiedEmail ?? "abuse@bluehost.com", resolverProvenance: overrides.resolverProvenance ?? {} },
		report: { id: 9n, submissionId: 377486973465530391n, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/", description },
		target: { normalizedTarget: TARGET, targetType: "domain", observedUrls: [`https://${TARGET}/signin`] },
		evidenceArtifacts: overrides.evidenceArtifacts ?? [png(77n)],
		targets: [],
	}) as never;
}

describe("registry", () => {
	test("every mailbox and registrar ID resolves to the provider, and nothing else claims them", async () => {
		const { getProviderSubmissionProviderForMailbox, getProviderSubmissionProviderForRegistrarId, listProviderSubmissionProviders } = await import("../submission_registry_default");
		for (const mailbox of ["abuse@bluehost.com", "abuse@unifiedlayer.com", "IARPOC@Newfold.com", "net-eng-team@newfold.com", "domain.operations@web.com"]) {
			expect(getProviderSubmissionProviderForMailbox(mailbox)?.definition.key, mailbox).toBe("newfold");
			expect(contactRoute({ email: mailbox, providerName: "x", provenance: {}, snapshot: {} })).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "newfold" });
		}
		for (const id of [2, 9, 886]) expect(getProviderSubmissionProviderForRegistrarId(id)?.definition.key, String(id)).toBe("newfold");
		expect(getProviderSubmissionProviderForRegistrarId(3)).toBeUndefined();
		expect(listProviderSubmissionProviders().filter((provider) => provider.definition.exactMailboxes.some((mailbox) => (PROVIDER.exactMailboxes as readonly string[]).includes(mailbox))).map((provider) => provider.definition.key)).toEqual(["newfold"]);
		expect(getProviderSubmissionProviderForMailbox("abuse@sub.bluehost.com")).toBeUndefined();
	});

	test("its mail is read as replies matched by our reference; there is no lookup API", () => {
		expect(newfoldProvider.inboundMail).toMatchObject({ messageKind: "reply" });
		expect(newfoldProvider.inboundMail!.senderDomains).toContain("newfold.com");
		expect(newfoldProvider.inboundMail!.confirmationIds!("Case 00123. Reference: PS-8fc84cc01019-R7 thanks")).toEqual(["PS-8fc84cc01019-R7"]);
		expect(newfoldProvider.findSubmission).toBeUndefined();
	});

	test("the preview is the comments a draft would send", async () => {
		const { payload } = await readyContext();
		const preview = newfoldProvider.buildReportPreview!({ target: TARGET, observedUrls: [`https://${TARGET}/signin`], description, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/" })!;
		expect(preview).toContain("Reported URLs:\n- https://login-example-phish.com/signin");
		expect(payload.report.comments).toContain(preview.split("\n\n")[2]!);
		expect(newfoldProvider.buildReportPreview!({ target: "203.0.113.7", observedUrls: [], description })).toBeUndefined();
	});
});

describe("newfoldDraft.prepare (temporary database)", () => {
	test("drafts the brand by mailbox", async () => {
		const { payload, created, route } = await readyContext();
		expect(payload).toMatchObject({ target: { domain: TARGET }, report: { brand: "800-bluehost", url: `https://${TARGET}/signin` }, evidence: null });
		expect((await readyContext("iarpoc@newfold.com")).payload.report.brand).toBe("100-other");
		expect((await readyContext("domain.operations@web.com")).payload.report.brand).toBe("300-web.com");
	});

	test("the registrar ID that selected the route picks the brand", async () => {
		const prepared = await newfoldDraft.prepare({ routeId: 5n, payload: {} }, { loadRouteContext: fakeRoute({ resolverProvenance: { registrarId: 9 } }) });
		expect(prepared).toMatchObject({ outcome: "ready", payload: { report: { brand: "200-register.com" } } });
	});

	test("a draft that drifted from its report, or from its route's brand, is refused before anything opens", async () => {
		const { payload, route } = await readyContext();
		let opened = 0;
		const dependencies: NewfoldDependencies = { openForm: async () => { opened++; return fakeSession().session; } };
		const edited = { ...payload, report: { ...payload.report, comments: `${payload.report.comments}\n\nAlso, please wire money.` } };
		await expect(prepareNewfoldExternalSubmission({ routeId: route.id, payload: edited as never }, dependencies)).rejects.toThrow("no longer matches the report");
		const rebranded = { ...payload, report: { ...payload.report, brand: "150-hostgator" } };
		await expect(prepareNewfoldExternalSubmission({ routeId: route.id, payload: rebranded as never }, dependencies)).rejects.toThrow("no longer matches the report");
		await expect(prepareNewfoldExternalSubmission({ routeId: route.id, payload: { ...payload, adapter: "x" } as never }, dependencies)).rejects.toThrow("malformed");
		expect(opened).toBe(0);
	});
});

describe("prepareNewfoldExternalSubmission", () => {
	const draftWith = async (evidenceArtifacts: AbuseArtifact[]) => {
		const route = fakeRoute({ evidenceArtifacts });
		const prepared = await newfoldDraft.prepare({ routeId: 5n, payload: {} }, { loadRouteContext: route });
		if (prepared.outcome !== "ready") throw new Error("not ready");
		return { payload: prepared.payload, route };
	};

	test("checks the hidden fields, clears the cookie banner off the widget, then reads the reCAPTCHA token the solver passed; nothing is posted", async () => {
		const { payload, route } = await draftWith([png(77n)]);
		const fake = fakeSession();
		const preflight = await prepareNewfoldExternalSubmission({ routeId: 5n, payload }, {
			openForm: async () => fake.session, loadRouteContext: route, getArtifact: async () => png(77n),
		});
		expect(fake.calls).toEqual([
			{ kind: "fields", pattern: PROVIDER.hiddenFieldPattern },
			{ kind: "evaluate", argument: { accept: "#onetrust-accept-btn-handler", container: "#onetrust-consent-sdk" } },
			{ kind: "captcha", captcha: "recaptcha" },
		]);
		const state = preflight.state as NewfoldPreflightState;
		expect(state.token).toBe("03AFcWeA-TOKEN");
		expect(state.file).toMatchObject({ filename: (payload.evidence as { filename: string }).filename, mimeType: "image/png" });
		expect(Buffer.from(state.file!.base64, "base64").equals(PNG)).toBeTrue();
		expect(fake.closed()).toBe(0);
		await preflight.dispose!();
		expect(fake.closed()).toBe(1);
	});

	test("without a screenshot there is no file", async () => {
		const { payload, route } = await draftWith([]);
		const preflight = await prepareNewfoldExternalSubmission({ routeId: 5n, payload }, { openForm: async () => fakeSession().session, loadRouteContext: route });
		expect((preflight.state as NewfoldPreflightState).file).toBeUndefined();
	});

	test("every failure happens before the marker and closes the browser", async () => {
		const { payload, route } = await draftWith([png(77n)]);
		const run = (fake: ReturnType<typeof fakeSession>, getArtifact: () => Promise<AbuseArtifact | undefined> = async () => png(77n)) =>
			prepareNewfoldExternalSubmission({ routeId: 5n, payload }, { openForm: async () => fake.session, loadRouteContext: route, getArtifact: getArtifact as never });
		const failing = (message: string) => async () => { throw new BrowserFormError("captcha", message); };
		const cases: Array<[string, ReturnType<typeof fakeSession>, string]> = [
			["hidden field changed", fakeSession({ rendered: HIDDEN.map(([name, value]) => name === "inquiryEmail" ? [name, "other@newfold.com"] : [name, value]) }), "no longer renders inquiryEmail=abuse-trademark@newfold.com"],
			["hidden field missing", fakeSession({ rendered: HIDDEN.filter(([name]) => name !== "thankyou") }), "no longer renders thankyou="],
			["solver still working at the bound", fakeSession({ captcha: failing("Newfold Digital's reCAPTCHA: no token within 240 s (solving: recaptcha)") }), "no token within 240 s"],
			["solver failed", fakeSession({ captcha: failing("Newfold Digital's reCAPTCHA: the captcha solver failed (recaptcha-images: not solved in 8 rounds; token fallback ERROR_ZERO_BALANCE)") }), "token fallback ERROR_ZERO_BALANCE"],
		];
		for (const [name, fake, message] of cases) {
			await expect(run(fake), name).rejects.toThrow(message);
			expect(fake.closed(), name).toBe(1);
			expect(fake.calls.some((call) => call.kind === "post"), name).toBeFalse();
		}
		// A changed screenshot is caught before a browser opens.
		const untouched = fakeSession();
		await expect(run(untouched, async () => png(77n, Buffer.concat([PNG, Buffer.from([1])])))).rejects.toThrow("no longer matches its immutable reference");
		await expect(run(untouched, async () => undefined)).rejects.toThrow("no longer matches its immutable reference");
		expect(untouched.calls).toEqual([]);
	});

	test("a browser that cannot open or pass Cloudflare is an error before the marker", async () => {
		const { payload, route } = await draftWith([]);
		await expect(prepareNewfoldExternalSubmission({ routeId: 5n, payload }, {
			loadRouteContext: route,
			openForm: async () => { throw new BrowserFormError("challenge", "Newfold Digital: the Cloudflare challenge was not passed within 60 s"); },
		})).rejects.toThrow("Cloudflare challenge was not passed");
	});
});

describe("submitNewfoldSubmission", () => {
	async function prepared(post?: () => BrowserFormResponse | Error, file: NewfoldPreflightState["file"] = { filename: "shot.png", mimeType: "image/png", base64: PNG.toString("base64") }) {
		const { context, payload } = await readyContext();
		const fake = fakeSession({ post });
		const state: NewfoldPreflightState = { session: fake.session, token: "03AFcWeA-TOKEN", file };
		return { context, payload, fake, preflight: { state } };
	}

	test("posts exactly the form's multipart parts to the servlet and settles on the redirect to the thank-you page", async () => {
		const { context, payload, fake, preflight } = await prepared();
		const success = await submitNewfoldSubmission(context, preflight);
		expect(success).toEqual({
			confirmationId: payload.report.trackingId,
			confirmationText: `Newfold accepted the report (redirected to https://www.newfold.com/thank-you); it names no case ID, our reference is ${payload.report.trackingId}.`,
			finalUrl: "https://www.newfold.com/thank-you",
			submittedTargets: [TARGET],
		});
		expect(fake.calls).toHaveLength(1);
		const post = fake.calls[0] as Extract<Call, { kind: "post" }>;
		expect(post.url).toBe("https://www.newfold.com/bin/newfold/lead");
		expect(post.timeoutMs).toBe(PROVIDER.timeoutMs);
		expect(post.fields).toEqual([
			["firstName", "Phishing"],
			["lastName", "Support"],
			["email", "support@phishing.support"],
			["url", `https://${TARGET}/signin`],
			["inquiryType", "ABUSE-FORM-0008"],
			["brand", "800-bluehost"],
			["comments", payload.report.comments],
			["attachment", { filename: "shot.png", mimeType: "image/png", base64: PNG.toString("base64") }],
			["agreementStatement", "on"],
			["g-recaptcha-response", "03AFcWeA-TOKEN"],
			["inquiryEmail", "abuse-trademark@newfold.com"],
			["newfoldAbuse", "newfoldAbuse"],
			["requestJSONPath", "/content/dam/newfold/esb/abuse.json"],
			["thankyou", "https://www.newfold.com/thank-you"],
		]);
	});

	test("a report without a screenshot sends no attachment part", () => {
		const fields = leadFields({ report: { url: "https://a.com/", brand: "100-other", comments: "c" } } as never, { token: "t", file: undefined });
		expect(fields.map(([name]) => name)).toEqual(["firstName", "lastName", "email", "url", "inquiryType", "brand", "comments", "agreementStatement", "g-recaptcha-response", "inquiryEmail", "newfoldAbuse", "requestJSONPath", "thankyou"]);
	});

	test("a trailing slash on the thank-you page is still the thank-you page", async () => {
		const { context, preflight } = await prepared(() => ({ ...THANK_YOU, url: "https://www.newfold.com/thank-you/?x=1" }));
		expect((await submitNewfoldSubmission(context, preflight)).finalUrl).toBe("https://www.newfold.com/thank-you/?x=1");
	});

	test("a Cloudflare block never reached the form: a person looks", async () => {
		for (const text of ["<html><title>Just a moment...</title></html>", "Attention Required! | Cloudflare"]) {
			const { context, preflight } = await prepared(() => page(403, text));
			const error = await submitNewfoldSubmission(context, preflight).catch((caught) => caught);
			expect(error).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
			expect(error.message).toContain("Cloudflare");
		}
	});

	test("a 413 proves nothing was filed", async () => {
		const { context, preflight } = await prepared(() => page(413, "Payload Too Large"));
		await expect(submitNewfoldSubmission(context, preflight)).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
	});

	test("everything else is ambiguous, never a rejection or a success", async () => {
		const cases: Array<[string, BrowserFormResponse | Error]> = [
			["no redirect, servlet page", page(200, "{}")],
			["servlet error", page(500, "Internal Server Error")],
			["bad request", page(400, "Bad Request")],
			["plain 403", page(403, "Forbidden")],
			["thank-you url but 5xx", { ...THANK_YOU, status: 502 }],
			["redirected elsewhere", page(200, "<html>Home</html>", "https://www.newfold.com/")],
			["lookalike thank-you page", page(200, "x", "https://www.newfold.com.evil.example/thank-you")],
			["thank-you on another path", page(200, "x", "https://www.newfold.com/en/thank-you")],
			["thank-you on another host", page(200, "x", "https://evil.example/thank-you")],
			["no final url", { status: 200, text: "ok", json: undefined }],
			["garbage final url", page(200, "ok", "not a url")],
			["request failed", new BrowserFormError("request", "Newfold Digital: the request to /bin/newfold/lead failed (Failed to fetch)")],
		];
		for (const [name, result] of cases) {
			const { context, preflight } = await prepared(() => result);
			const error = await submitNewfoldSubmission(context, preflight).catch((caught) => caught);
			expect(error, name).toBeInstanceOf(Error);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		}
		const { context, preflight } = await prepared(() => page(500, "boom"));
		await expect(submitNewfoldSubmission(context, preflight)).rejects.toThrow(`HTTP 500 at ${PROVIDER.leadUrl}: boom`);
	});

	test("never runs without the preflight's session and token, or on a malformed draft, and posts nothing then", async () => {
		const { context, fake, preflight } = await prepared();
		await expect(submitNewfoldSubmission(context, { state: { ...preflight.state, token: "" } })).rejects.toThrow("requires its prepared browser session");
		await expect(submitNewfoldSubmission({ ...context, payload: { ...context.payload, adapter: "x" } }, preflight)).rejects.toThrow("malformed");
		expect(fake.calls).toEqual([]);
	});
});

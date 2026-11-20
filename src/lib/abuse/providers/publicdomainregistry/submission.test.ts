import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../../../db/test_helpers";
import { contactRoute } from "../../resolver/routes";
import type { AbuseArtifact } from "../../schema";
import { BrowserFormError, type BrowserFormField, type BrowserFormResponse, type BrowserFormSession } from "../kit/browser_form";
import { DESCRIPTION as description, formAnswer as answer, pngArtifact as png, PNG, readyDraft, TARGET, verifiedPrepare } from "../kit/testing";
import { ProviderSubmissionNeedsHumanError, ProviderSubmissionRejectedError } from "../submission_contracts";
import { PUBLIC_DOMAIN_REGISTRY_PROVIDER as PROVIDER } from "./definition";
import { publicDomainRegistryProvider } from "./index";
import { storedPublicDomainRegistrySubmissionPayload } from "./payload";
import { feedbackFields, preparePublicDomainRegistryExternalSubmission as rawPreparePublicDomainRegistryExternalSubmission, publicDomainRegistryDraft, submitPublicDomainRegistrySubmission, uploadedPath, type PublicDomainRegistryDependencies, type PublicDomainRegistryPreflightState } from "./submission";

const preparePublicDomainRegistryExternalSubmission = verifiedPrepare(publicDomainRegistryDraft, rawPreparePublicDomainRegistryExternalSubmission);

useTemporaryDatabase();

const MAILBOXES = ["abuse-contact@publicdomainregistry.com", "abuse@publicdomainregistry.com"];
const readyContext = () => readyDraft({ mailbox: MAILBOXES[0]!, providerName: "PDR" }, publicDomainRegistryDraft.prepare, storedPublicDomainRegistrySubmissionPayload);

const RENDERED: BrowserFormField[] = [
	["_wpcf7", "643"], ["_wpcf7_version", "6.2.4.1"], ["_wpcf7_locale", "en_US"], ["_wpcf7_unit_tag", "wpcf7-f643-p645-o1"],
	["_wpcf7_container_post", "645"], ["_wpcf7_posted_data_hash", ""], ["wpcf7_hp_field", ""], ["_wpcf7_ak_js", "1795179048749"], ["_wpcf7_ak_hp_textarea", ""],
];

type Call = { kind: "global"; path: string } | { kind: "turnstile" } | { kind: "fields"; pattern: string } | { kind: "post"; url: string; fields: BrowserFormField[]; timeoutMs: number | undefined };

function fakeSession(options: { post?: (url: string) => BrowserFormResponse | Error; rendered?: BrowserFormField[]; nonce?: unknown; turnstile?: () => Promise<string> } = {}) {
	const calls: Call[] = [];
	let closed = 0;
	const session: BrowserFormSession = {
		readGlobal: async (path) => { calls.push({ kind: "global", path }); return "nonce" in options ? options.nonce : "a0dd4cf355"; },
		waitForCaptchaToken: options.turnstile ? async () => { calls.push({ kind: "turnstile" }); return options.turnstile!(); } : async () => { calls.push({ kind: "turnstile" }); return "0.TURNSTILE"; },
		readFormFields: async (pattern) => { calls.push({ kind: "fields", pattern }); return options.rendered ?? RENDERED; },
		postForm: async (url, fields, timeoutMs) => {
			calls.push({ kind: "post", url, fields: [...fields], timeoutMs });
			const answer = options.post?.(url) ?? { status: 200, text: "{}", json: {} };
			if (answer instanceof Error) throw answer;
			return answer;
		},
		close: async () => { closed++; },
	};
	return { session, calls, closed: () => closed };
}
const UPLOAD_OK = answer({ success: true, data: { path: "36aa617f-5672-490f-a777-65869197ecf0", file: "shot-2.png" } });

function fakeRoute(payload: Record<string, unknown>, overrides: Partial<{ evidenceArtifacts: AbuseArtifact[]; version: string }> = {}) {
	return async () => ({
		route: { id: 5n, reportId: 9n, routeType: "provider_submission", providerRegistryKey: "publicdomainregistry", providerDefinitionVersion: overrides.version ?? PROVIDER.version, providerDefinitionHash: PROVIDER.contentHash, routeMetadata: {} },
		report: { id: 9n, submissionId: 377486973465530391n, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/", description },
		target: { normalizedTarget: (payload.target as { domain: string }).domain, targetType: "domain", observedUrls: [`https://${TARGET}/signin`] },
		evidenceArtifacts: overrides.evidenceArtifacts ?? [png(77n)],
		targets: [],
	}) as never;
}

describe("registry", () => {
	test("both mailboxes and IANA 303 resolve to the provider, and nothing else claims them", async () => {
		const { getProviderSubmissionProviderForMailbox, getProviderSubmissionProviderForRegistrarId, listProviderSubmissionProviders } = await import("../submission_registry_default");
		for (const mailbox of MAILBOXES) {
			expect(getProviderSubmissionProviderForMailbox(mailbox)?.definition.key).toBe("publicdomainregistry");
			expect(contactRoute({ email: mailbox, providerName: "PDR", provenance: {}, snapshot: {} })).toMatchObject({ routeType: "provider_submission", providerRegistryKey: "publicdomainregistry" });
		}
		expect(getProviderSubmissionProviderForRegistrarId(303)?.definition.key).toBe("publicdomainregistry");
		expect(listProviderSubmissionProviders().filter((provider) => provider.definition.exactMailboxes.some((mailbox) => MAILBOXES.includes(mailbox))).map((provider) => provider.definition.key)).toEqual(["publicdomainregistry"]);
		expect(getProviderSubmissionProviderForMailbox("abuse@sub.publicdomainregistry.com")).toBeUndefined();
	});

	test("its mail is read as replies matched by our reference; there is no lookup API", () => {
		expect(publicDomainRegistryProvider.inboundMail).toMatchObject({ senderDomains: ["publicdomainregistry.com"], messageKind: "reply" });
		expect(publicDomainRegistryProvider.inboundMail!.confirmationIds!("Ticket 4412. Reference: PS-8fc84cc01019-R7 thanks")).toEqual(["PS-8fc84cc01019-R7"]);
		expect(publicDomainRegistryProvider.findSubmission).toBeUndefined();
	});

	test("the preview is the complaint a draft would send", async () => {
		const { payload } = await readyContext();
		const preview = publicDomainRegistryProvider.buildReportPreview!({ target: TARGET, observedUrls: [`https://${TARGET}/signin`], description, allegationCategory: "phishing", legalBrandUrl: "https://www.examplebank.com/" })!;
		expect(preview).toContain("Reported URLs:\n- https://login-example-phish.com/signin");
		expect(payload.report.complaint).toContain(preview.split("\n\n")[2]!);
		expect(publicDomainRegistryProvider.buildReportPreview!({ target: "203.0.113.7", observedUrls: [], description })).toBeUndefined();
	});
});

describe("publicDomainRegistryDraft.prepare (temporary database)", () => {
	test("drafts the domain without a screenshot, its complaint led by the reference", async () => {
		const { payload, created, route } = await readyContext();
		expect(payload).toMatchObject({ target: { domain: TARGET }, evidence: null });
		expect(payload.report.complaint).toContain(`Reference: ${payload.report.trackingId}\n\nReported URLs:\n- https://${TARGET}/signin`);
	});

	test("a draft that drifted from its report is refused before anything opens", async () => {
		const { payload, route } = await readyContext();
		let opened = 0;
		const dependencies: PublicDomainRegistryDependencies = { openForm: async () => { opened++; return fakeSession().session; } };
		const edited = { ...payload, report: { ...payload.report, complaint: `${payload.report.complaint}\n\nAlso, please wire money.` } };
		await expect(preparePublicDomainRegistryExternalSubmission({ routeId: route.id, payload: edited as never }, dependencies)).rejects.toThrow("no longer matches the report");
		await expect(preparePublicDomainRegistryExternalSubmission({ routeId: route.id, payload: { ...payload, adapter: "x" } as never }, dependencies)).rejects.toThrow("malformed");
		expect(opened).toBe(0);
	});
});

describe("preparePublicDomainRegistryExternalSubmission", () => {
	const draftWith = async (evidenceArtifacts: AbuseArtifact[]) => {
		const route = fakeRoute({ target: { domain: TARGET } }, { evidenceArtifacts });
		const prepared = await publicDomainRegistryDraft.prepare({ routeId: 5n, payload: {} }, { loadRouteContext: route });
		if (prepared.outcome !== "ready") throw new Error("not ready");
		return { payload: prepared.payload, route };
	};

	test("uploads the screenshot as the page's uploader does, then takes the token and the page's own fields", async () => {
		const { payload, route } = await draftWith([png(77n)]);
		expect((payload.evidence as { artifactId: string }).artifactId).toBe("77");
		const fake = fakeSession({ post: () => UPLOAD_OK });
		const preflight = await preparePublicDomainRegistryExternalSubmission({ routeId: 5n, payload }, { openForm: async () => fake.session, loadRouteContext: route, getArtifact: async () => png(77n) });
		expect(fake.calls.map((call) => call.kind)).toEqual(["global", "post", "turnstile", "fields"]);
		expect(fake.calls[0]).toEqual({ kind: "global", path: "dnd_cf7_uploader.ajax_nonce" });
		const upload = fake.calls[1] as Extract<Call, { kind: "post" }>;
		expect(upload.url).toBe(PROVIDER.uploadUrl);
		const fields = new Map(upload.fields.map(([name, value]) => [name, value]));
		expect(Object.fromEntries([...fields].filter(([, value]) => typeof value === "string" && !/^[0-9a-f-]{36}$/.test(value)))).toEqual({ action: "dnd_codedropz_upload", type: "click", security: "a0dd4cf355", hp_field: "", form_id: "643", upload_name: "upload-file-448" });
		expect(fields.get("upload_folder")).toMatch(/^[0-9a-f-]{36}$/);
		expect(fields.get("token")).toMatch(/^[0-9a-f-]{36}$/);
		const file = fields.get("upload-file") as { filename: string; mimeType: string; base64: string };
		expect([file.filename, file.mimeType, Buffer.from(file.base64, "base64").equals(PNG)]).toEqual([(payload.evidence as { filename: string }).filename, "image/png", true]);
		expect(fake.calls[3]).toEqual({ kind: "fields", pattern: "^_?wpcf7" });
		expect(preflight.state).toMatchObject({ token: "0.TURNSTILE", rendered: RENDERED, uploads: ["36aa617f-5672-490f-a777-65869197ecf0/shot-2.png"] });
		expect(fake.closed()).toBe(0);
		await preflight.dispose!();
		expect(fake.closed()).toBe(1);
	});

	test("without a screenshot there is no upload", async () => {
		const { payload, route } = await draftWith([]);
		expect(payload.evidence).toBeNull();
		const fake = fakeSession();
		const preflight = await preparePublicDomainRegistryExternalSubmission({ routeId: 5n, payload }, { openForm: async () => fake.session, loadRouteContext: route });
		expect(fake.calls.map((call) => call.kind)).toEqual(["turnstile", "fields"]);
		expect((preflight.state as PublicDomainRegistryPreflightState).uploads).toEqual([]);
	});

	test("every failure happens before the marker and closes the browser", async () => {
		const { payload, route } = await draftWith([png(77n)]);
		const run = (fake: ReturnType<typeof fakeSession>, getArtifact: () => Promise<AbuseArtifact | undefined> = async () => png(77n)) =>
			preparePublicDomainRegistryExternalSubmission({ routeId: 5n, payload }, { openForm: async () => fake.session, loadRouteContext: route, getArtifact: getArtifact as never });
		const cases: Array<[string, ReturnType<typeof fakeSession>, string]> = [
			["no nonce", fakeSession({ nonce: undefined }), "no upload nonce"],
			["upload refused", fakeSession({ post: () => answer({ success: false, data: "File type not allowed" }, 200) }), "upload was not accepted"],
			["upload HTTP 403", fakeSession({ post: () => ({ status: 403, text: "<html>Just a moment</html>", json: undefined }) }), "upload was not accepted (HTTP 403): <html>Just a moment</html>"],
			["upload path traversal", fakeSession({ post: () => answer({ success: true, data: { path: "../x", file: "a.png" } }) }), "upload was not accepted"],
			["token not issued", fakeSession({ post: () => UPLOAD_OK, turnstile: async () => { throw new BrowserFormError("captcha", "PublicDomainRegistry's Cloudflare Turnstile: no token within 240 s (no captcha state)"); } }), "no token within 240 s"],
			["form id changed", fakeSession({ post: () => UPLOAD_OK, rendered: RENDERED.map(([name, value]) => name === "_wpcf7" ? [name, "999"] : [name, value]) }), "no longer Contact Form 7 form 643"],
			["field missing", fakeSession({ post: () => UPLOAD_OK, rendered: RENDERED.filter(([name]) => name !== "_wpcf7_unit_tag") }), "no longer renders _wpcf7_unit_tag"],
		];
		for (const [name, fake, message] of cases) {
			await expect(run(fake), name).rejects.toThrow(message);
			expect(fake.closed(), name).toBe(1);
		}
		// A changed screenshot is caught before a browser opens.
		const untouched = fakeSession();
		await expect(run(untouched, async () => png(77n, Buffer.concat([PNG, Buffer.from([1])])))).rejects.toThrow("no longer matches its immutable reference");
		await expect(run(untouched, async () => undefined)).rejects.toThrow("no longer matches its immutable reference");
		expect(untouched.calls).toEqual([]);
	});

	test("a browser that cannot open or pass Cloudflare's challenge is an error before the marker", async () => {
		const { payload, route } = await draftWith([]);
		await expect(preparePublicDomainRegistryExternalSubmission({ routeId: 5n, payload }, {
			loadRouteContext: route,
			openForm: async () => { throw new BrowserFormError("challenge", "PublicDomainRegistry: the Cloudflare challenge was not passed within 60 s"); },
		})).rejects.toThrow("Cloudflare challenge was not passed");
	});
});

describe("uploadedPath", () => {
	test("the folder and file the feedback names, or an error", () => {
		expect(uploadedPath(UPLOAD_OK)).toBe("36aa617f-5672-490f-a777-65869197ecf0/shot-2.png");
		for (const bad of [answer({ success: true }), answer({ success: true, data: { path: "", file: "a.png" } }), answer({ success: false, data: { path: "a", file: "b" } }), answer({ success: true, data: { path: "a b", file: "b.png" } }), { status: 200, text: "x", json: undefined }, answer({ success: true, data: { path: "a", file: "b" } }, 500)]) {
			expect(() => uploadedPath(bad)).toThrow("upload was not accepted");
		}
	});
});

describe("submitPublicDomainRegistrySubmission", () => {
	async function prepared(uploads: string[] = ["36aa617f-5672-490f-a777-65869197ecf0/shot-2.png"], post?: (url: string) => BrowserFormResponse | Error) {
		const { context, payload } = await readyContext();
		const fake = fakeSession({ post });
		const state: PublicDomainRegistryPreflightState = { session: fake.session, token: "0.TURNSTILE", rendered: RENDERED, uploads };
		return { context, payload, fake, preflight: { state } };
	}

	test("posts exactly the form's fields to Contact Form 7's feedback and settles on mail_sent", async () => {
		const { context, payload, fake, preflight } = await prepared(undefined, () => answer({ status: "mail_sent", message: "Thank you. Your report was sent." }));
		const success = await submitPublicDomainRegistrySubmission(context, preflight);
		expect(success).toEqual({
			confirmationId: payload.report.trackingId,
			confirmationText: "PublicDomainRegistry accepted the report: Thank you. Your report was sent.",
			finalUrl: PROVIDER.formUrl,
			submittedTargets: [TARGET],
		});
		expect(fake.calls).toHaveLength(1);
		const post = fake.calls[0] as Extract<Call, { kind: "post" }>;
		expect(post.url).toBe("https://publicdomainregistry.com/wp-json/contact-form-7/v1/contact-forms/643/feedback");
		expect(post.timeoutMs).toBe(PROVIDER.timeoutMs);
		expect(post.fields).toEqual([
			...RENDERED,
			["your-name", "Phishing Support"],
			["text-748", TARGET],
			["textarea-66", payload.report.complaint],
			["your-email", "support@phishing.support"],
			["upload-file-448[]", "36aa617f-5672-490f-a777-65869197ecf0/shot-2.png"],
			["gdpr-privacy-policy[]", "I agree to the Terms of Service and the Privacy Notice"],
			["cf-turnstile-response", "0.TURNSTILE"],
		]);
		expect(post.fields.some(([name]) => name === "gdpr-marketing-mails[]")).toBeFalse();
	});

	test("a report without a screenshot sends no upload part", () => {
		const fields = feedbackFields({ target: { domain: TARGET }, report: { complaint: "c" } } as never, { rendered: [], token: "t", uploads: [] });
		expect(fields.map(([name]) => name)).toEqual(["your-name", "text-748", "textarea-66", "your-email", "gdpr-privacy-policy[]", "cf-turnstile-response"]);
	});

	test("statuses that prove nothing was filed are rejections, naming the invalid fields", async () => {
		for (const status of ["validation_failed", "aborted", "acceptance_missing", "init_failed"]) {
			const { context, preflight } = await prepared(undefined, () => answer({ status, message: "One or more fields have an error.", invalid_fields: [{ field: "text-748", message: "Required" }, { field: "your-email" }] }));
			const error = await submitPublicDomainRegistrySubmission(context, preflight).catch((caught) => caught);
			expect(error, status).toBeInstanceOf(ProviderSubmissionRejectedError);
			expect(error.message).toBe(`PublicDomainRegistry refused the report (${status}: text-748, your-email): One or more fields have an error.`);
		}
	});

	test("an Akismet spam verdict filed nothing and goes to a person, not a terminal refusal", async () => {
		const { context, preflight } = await prepared(undefined, () => answer({ status: "spam", message: "There was an error trying to send your message." }));
		const error = await submitPublicDomainRegistrySubmission(context, preflight).catch((caught) => caught);
		expect(error).toBeInstanceOf(ProviderSubmissionNeedsHumanError);
		expect(error.message).toContain("Akismet");
	});

	test("everything else is ambiguous, never a rejection", async () => {
		const cases: Array<[string, BrowserFormResponse | Error]> = [
			["mail_failed", answer({ status: "mail_failed", message: "There was an error trying to send your message." })],
			["unknown status", answer({ status: "queued" })],
			["no status", answer({ message: "ok" })],
			["cloudflare challenge", { status: 403, text: "<html>Just a moment...</html>", json: undefined }],
			["server error", { status: 500, text: "boom", json: undefined }],
			["non-JSON 200", { status: 200, text: "<html>ok</html>", json: undefined }],
			["json null", answer(null)],
			["request failed", new BrowserFormError("request", "PublicDomainRegistry: the request to /wp-json failed (Failed to fetch)")],
		];
		for (const [name, result] of cases) {
			const { context, preflight } = await prepared(undefined, () => result);
			const error = await submitPublicDomainRegistrySubmission(context, preflight).catch((caught) => caught);
			expect(error, name).toBeInstanceOf(Error);
			expect(error, name).not.toBeInstanceOf(ProviderSubmissionRejectedError);
		}
		const { context, preflight } = await prepared(undefined, () => answer({ status: "mail_failed" }));
		await expect(submitPublicDomainRegistrySubmission(context, preflight)).rejects.toThrow("HTTP 200 and status mail_failed");
	});

	test("never runs without the preflight's session and token, or on a malformed draft, and reads nothing else from the database", async () => {
		const { context, fake, preflight } = await prepared();
		await expect(submitPublicDomainRegistrySubmission(context, { state: { ...preflight.state, token: "" } })).rejects.toThrow("requires its prepared browser session");
		await expect(submitPublicDomainRegistrySubmission({ ...context, payload: { ...context.payload, adapter: "x" } }, preflight)).rejects.toThrow("malformed");
		expect(fake.calls).toEqual([]);
		// The provider's submit entry points are the same single request.
	});
});

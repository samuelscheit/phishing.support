import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../../security";
import type { AbuseArtifact } from "../../schema";
import { mailedCodeFrom } from "../mailed_code";
import { getProviderSubmissionProviderForMailbox, getProviderSubmissionProviderForRegistrarId } from "../submission_registry_default";
import { ProviderSubmissionRejectedError } from "../submission_contracts";
import { GNAME_PROVIDER } from "./definition";
import { gnameProvider } from "./index";
import { buildGnameSubmissionPayload, gnameComplaintKind, gnameDomainEntry, selectGnameEvidenceArtifact, storedGnameSubmissionPayload } from "./payload";
import {
	gnameComplaintBody,
	prepareGnameExternalSubmission,
	prepareGnameSubmission,
	submitGnameSubmission,
	type GnameDependencies,
	type GnameResponse,
	type GnameSession,
	type GnameUpload,
} from "./submission";

// A minimal valid PNG: the evidence contract checks the magic bytes and digest.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
function pngArtifact(id: bigint, bytes: Buffer = PNG, name = "website.png"): AbuseArtifact {
	return { id, reportId: 9n, name, kind: "user_evidence_original", mimeType: "image/png", sha256: sha256Hex(bytes), size: bytes.byteLength, blob: bytes, metadata: {}, createdAt: new Date() } as unknown as AbuseArtifact;
}
const artifact = pngArtifact(77n);

const SUBMISSION = 377486973465530391n;
const CASE_PAGE = `https://phishing.support/submissions/${SUBMISSION.toString()}`;

function routeContext(options: { allegationCategory?: "phishing" | "malware"; legalBrandUrl?: string | null; observedUrls?: string[]; evidenceArtifacts?: AbuseArtifact[]; version?: string } = {}) {
	return async () => ({
		route: { id: 5n, routeType: "provider_submission", providerRegistryKey: "gname", providerDefinitionVersion: options.version ?? GNAME_PROVIDER.version, providerDefinitionHash: GNAME_PROVIDER.contentHash },
		report: {
			id: 9n,
			submissionId: SUBMISSION,
			allegationCategory: options.allegationCategory ?? "malware",
			legalBrandUrl: options.legalBrandUrl ?? null,
			description: "The page attacks its visitors' devices without any action from them (a drive-by exploit): a frame on it that no visitor can see runs an exploit loader.\nIt sends keychain, wallet data from the device to hxxps://92haoyun[.]icu/coruna-loot.",
		},
		target: { normalizedTarget: "92haoyun.icu", targetType: "domain", observedUrls: options.observedUrls ?? ["https://92haoyun.icu/"] },
		evidenceArtifacts: options.evidenceArtifacts ?? [artifact],
		targets: [],
	}) as never;
}

type Call = { kind: "post"; path: string; data: Record<string, unknown> } | { kind: "upload"; lx: number; file: GnameUpload } | { kind: "code"; email: string };

function gnameApi(responses: { upload?: () => GnameResponse; code?: () => GnameResponse; post?: (path: string) => GnameResponse }) {
	const calls: Call[] = [];
	let closed = 0;
	const opened: string[] = [];
	const session: GnameSession = {
		post: async (path, data) => {
			calls.push({ kind: "post", path, data });
			if (!responses.post) throw new Error(`unexpected GNAME post ${path}`);
			return responses.post(path);
		},
		upload: async (lx, file) => {
			calls.push({ kind: "upload", lx, file });
			if (!responses.upload) throw new Error("unexpected GNAME upload");
			return responses.upload();
		},
		requestCode: async (email) => {
			calls.push({ kind: "code", email });
			if (!responses.code) throw new Error("unexpected GNAME code request");
			return responses.code();
		},
		close: async () => { closed++; },
	};
	return { calls, session, openSession: async (kind: string) => { opened.push(kind); return session; }, closed: () => closed, opened };
}

const UPLOADED = () => ({ code: 1, msg: "", data: { path: "/upload/lyts/20261108/abc.png", uptoken: "next-token" } });
const CODE_SENT = () => ({ code: "1", msg: "An e-mail has been sent to your email address support@phishing.support, please check it.", data: "" });

async function readyPayload(options: Parameters<typeof routeContext>[0] = {}) {
	const prepared = await prepareGnameSubmission({ routeId: 5n, payload: {} }, { loadRouteContext: routeContext(options) });
	if (prepared.outcome !== "ready") throw new Error(`not ready: ${prepared.reason}`);
	return prepared.payload;
}

describe("GNAME abuse complaint form", () => {
	test("GNAME's registrar IDs and RDAP mailbox select its form", () => {
		for (const registrarId of [1923, 3941, 3950, 3980, 4142, 4164, 4312, 4343, 4542]) {
			expect(getProviderSubmissionProviderForRegistrarId(registrarId)?.definition.key).toBe("gname");
		}
		for (const registrarId of [1922, 3940, 3951, 4020, 4143, 4543]) {
			expect(getProviderSubmissionProviderForRegistrarId(registrarId)?.definition.key).not.toBe("gname");
		}
		expect(getProviderSubmissionProviderForMailbox("complaint@gname.com")?.definition.key).toBe("gname");
	});

	test("a malware report is an 'Other issue' complaint on category 4: screenshot and mailed code before the marker, one lyts_add after it", async () => {
		const payload = await readyPayload();
		expect(storedGnameSubmissionPayload(payload)).toMatchObject({
			target: { domain: "92haoyun.icu", observedUrl: "https://92haoyun.icu/" },
			report: { kind: "malware" },
			evidence: { artifactId: "77", mimeType: "image/png" },
		});
		// The malware type has no "legal brand URL" field.
		expect((payload.report as Record<string, unknown>).legalBrandUrl).toBeUndefined();

		const api = gnameApi({ upload: UPLOADED, code: CODE_SENT, post: () => ({ code: 1, msg: "ok", data: "GN2026110812345" }) });
		const codeRequests: Date[] = [];
		const deps: GnameDependencies = {
			openSession: api.openSession,
			loadRouteContext: routeContext(),
			getArtifact: async () => artifact,
			readCode: async (requestedAt) => { codeRequests.push(requestedAt); return "a1b2c3"; },
			now: () => new Date("2026-11-07T20:30:00Z"),
		};
		const preflight = await prepareGnameExternalSubmission({ routeId: 5n, payload }, deps);
		expect(api.opened).toEqual(["malware"]);
		expect(api.calls.map((call) => call.kind)).toEqual(["upload", "code"]);
		expect(api.calls[0]).toMatchObject({ kind: "upload", lx: 7, file: { mimeType: "image/png", base64: PNG.toString("base64") } });
		expect(api.calls[1]).toEqual({ kind: "code", email: "support@phishing.support" });
		expect(codeRequests).toEqual([new Date("2026-11-07T20:30:00Z")]);

		const success = await submitGnameSubmission({ routeId: 5n, payload }, preflight);
		const submitted = api.calls[2]!;
		expect(submitted).toMatchObject({ kind: "post", path: "/request/lyts_add" });
		const data = (submitted as { data: Record<string, unknown> }).data;
		expect(data).toEqual({
			lx: 7,
			sm: expect.any(String),
			zmwj: "",
			name: "Phishing Support",
			email: "support@phishing.support",
			eyzm: "a1b2c3",
			ymlb: [`92haoyun.icu|${Buffer.from("https://92haoyun.icu/").toString("base64")}`],
			pics: ["/upload/lyts/20261108/abc.png"],
		});
		expect(String(data.sm)).toStartWith("A suspected malware distribution domain report is being submitted to GNAME for 92haoyun.icu.");
		expect(String(data.sm).length).toBeLessThanOrEqual(1_000);
		await preflight.dispose?.();
		expect(api.closed()).toBe(1);
		expect(success).toEqual({
			confirmationId: "GN2026110812345",
			confirmationText: "GNAME accepted the complaint (case GN2026110812345).",
			finalUrl: "https://www.gname.com/abuse/category/4",
			submittedTargets: ["92haoyun.icu"],
		});
	});

	test("a phishing report is 'Set up phishing and fraud site' on category 2 and names the imitated brand, or the case page when none is known", async () => {
		const withBrand = await readyPayload({ allegationCategory: "phishing", legalBrandUrl: "https://www.okx.com/" });
		expect(gnameComplaintBody(storedGnameSubmissionPayload(withBrand)!, "x", ["/p.png"])).toMatchObject({ lx: 8, wzdz: "https://www.okx.com/" });
		const withoutBrand = await readyPayload({ allegationCategory: "phishing" });
		expect(gnameComplaintBody(storedGnameSubmissionPayload(withoutBrand)!, "x", ["/p.png"])).toMatchObject({ lx: 8, wzdz: CASE_PAGE });

		const api = gnameApi({ upload: UPLOADED, code: CODE_SENT });
		await prepareGnameExternalSubmission({ routeId: 5n, payload: withBrand }, { openSession: api.openSession, loadRouteContext: routeContext({ allegationCategory: "phishing" }), getArtifact: async () => artifact, readCode: async () => "1234" });
		expect(api.opened).toEqual(["phishing"]);
		expect(api.calls[0]).toMatchObject({ kind: "upload", lx: 8 });
	});

	test("the domain entry carries its URL base64-encoded after a bar, as the form joins it", () => {
		expect(gnameDomainEntry({ domain: "92haoyun.icu", observedUrl: "https://92haoyun.icu/gooll/gooll.html?x=1&y=ü" }))
			.toBe(`92haoyun.icu|${Buffer.from("https://92haoyun.icu/gooll/gooll.html?x=1&y=ü", "utf8").toString("base64")}`);
	});

	test("nothing is drafted without an observed URL, a screenshot under 2 MB, or the definition the route was pinned to", async () => {
		const prepare = (options: Parameters<typeof routeContext>[0]) => prepareGnameSubmission({ routeId: 5n, payload: {} }, { loadRouteContext: routeContext(options) });
		expect(await prepare({ observedUrls: [] })).toEqual({ outcome: "insufficient_evidence", reason: "gname_requires_an_observed_url" });
		expect(await prepare({ evidenceArtifacts: [] })).toEqual({ outcome: "insufficient_evidence", reason: "gname_requires_a_screenshot" });
		const oversized = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
		expect(await prepare({ evidenceArtifacts: [pngArtifact(78n, oversized)] })).toEqual({ outcome: "insufficient_evidence", reason: "gname_requires_a_screenshot" });
		expect(await prepare({ version: "2026-08-13.3" })).toEqual({ outcome: "insufficient_evidence", reason: "gname_provider_definition_pin_mismatch" });
		// The first screenshot that fits is the one sent.
		expect(selectGnameEvidenceArtifact([pngArtifact(78n, oversized), pngArtifact(79n)])?.artifactId).toBe("79");
	});

	test("GNAME's named refusals are known rejections; its per-domain refusals are spelled out", async () => {
		const payload = await readyPayload();
		const reject = async (response: GnameResponse) => {
			const api = gnameApi({ post: () => response });
			return submitGnameSubmission({ routeId: 5n, payload }, { state: { session: api.session, code: "a1b2c3", pics: ["/p.png"] } });
		};
		await expect(reject({ code: -1, msg: "Verification code error" })).rejects.toThrow(new ProviderSubmissionRejectedError("GNAME rejected the report: Verification code error (code -1)"));
		await expect(reject({ code: -2, msg: "", data: [{ ym: "92haoyun.icu", msg: "The domain is not registered with GNAME" }] }))
			.rejects.toThrow("GNAME rejected the report: no message (code -2) (92haoyun.icu: The domain is not registered with GNAME)");
		await expect(reject({ code: -2, msg: "x", data: [{ ym: "92haoyun.icu", msg: "y" }] })).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);

		// An accepted complaint without a case number is still accepted.
		const api = gnameApi({ post: () => ({ code: "1", msg: "ok" }) });
		expect(await submitGnameSubmission({ routeId: 5n, payload }, { state: { session: api.session, code: "a1b2c3", pics: ["/p.png"] } }))
			.toMatchObject({ confirmationText: "GNAME accepted the complaint." });
		expect((await submitGnameSubmission({ routeId: 5n, payload }, { state: { session: api.session, code: "a1b2c3", pics: ["/p.png"] } })).confirmationId).toBeUndefined();
	});

	test("submit never runs without the preflight's session, code, and uploaded screenshot", async () => {
		const payload = await readyPayload();
		const api = gnameApi({ post: () => ({ code: 1, data: "GN1" }) });
		for (const state of [undefined, { code: "a1", pics: ["/p.png"] }, { session: api.session, code: "", pics: ["/p.png"] }, { session: api.session, code: "a1", pics: [] }]) {
			await expect(submitGnameSubmission({ routeId: 5n, payload }, state ? { state } : undefined)).rejects.toThrow("prepared verification code");
		}
		expect(api.calls).toEqual([]);
		await expect(submitGnameSubmission({ routeId: 5n, payload: { ...payload, adapter: "eranet_phishing_report_v1" } }, { state: { session: api.session, code: "a1", pics: ["/p.png"] } }))
			.rejects.toThrow("malformed");
	});

	test("every preflight failure happens before the marker and closes its browser: a refused upload, a code GNAME will not send, a code that never arrives, a changed screenshot", async () => {
		const payload = await readyPayload();
		const run = async (api: ReturnType<typeof gnameApi>, overrides: Partial<GnameDependencies> = {}) => prepareGnameExternalSubmission({ routeId: 5n, payload }, {
			openSession: api.openSession,
			loadRouteContext: routeContext(),
			getArtifact: async () => artifact,
			readCode: async () => "a1b2c3",
			...overrides,
		});

		const refusedUpload = gnameApi({ upload: () => ({ code: -1, msg: "The file is too large" }) });
		await expect(run(refusedUpload)).rejects.toThrow("GNAME screenshot upload failed: The file is too large (code -1)");
		expect(refusedUpload.closed()).toBe(1);

		const noPath = gnameApi({ upload: () => ({ code: 1, data: {} }) });
		await expect(run(noPath)).rejects.toThrow("GNAME screenshot upload failed");

		const noCode = gnameApi({ upload: UPLOADED, code: () => ({ code: -105001, msg: "Request parameter error", data: { verify: { style: "slider", lx: "lyts" } } }) });
		await expect(run(noCode)).rejects.toThrow("GNAME did not send its verification code: Request parameter error (code -105001)");
		expect(noCode.closed()).toBe(1);

		const silent = gnameApi({ upload: UPLOADED, code: CODE_SENT });
		await expect(run(silent, { readCode: async () => { throw new Error("GNAME's verification code did not arrive in time."); } })).rejects.toThrow("did not arrive in time");
		expect(silent.closed()).toBe(1);
		expect(silent.calls.some((call) => call.kind === "post")).toBe(false);

		const changed = gnameApi({ upload: UPLOADED, code: CODE_SENT });
		await expect(run(changed, { getArtifact: async () => pngArtifact(77n, Buffer.concat([PNG, Buffer.from([2])])) })).rejects.toThrow("no longer matches");
		// The artifact is checked before a browser opens.
		expect(changed.opened).toEqual([]);
	});

	test("a stored draft from another definition, kind, or with a brand field the type lacks is refused", async () => {
		const payload = await readyPayload();
		expect(storedGnameSubmissionPayload(payload)).toBeDefined();
		expect(storedGnameSubmissionPayload({ ...payload, definition: { version: "2026-08-13.3", contentHash: "x" } })).toBeUndefined();
		const report = payload.report as Record<string, unknown>;
		expect(storedGnameSubmissionPayload({ ...payload, report: { ...report, kind: "spam" } })).toBeUndefined();
		expect(storedGnameSubmissionPayload({ ...payload, report: { ...report, legalBrandUrl: "https://brand.example/" } })).toBeUndefined();
		expect(storedGnameSubmissionPayload({ ...payload, report: { ...report, description: "x".repeat(1_001) } })).toBeUndefined();
		expect(storedGnameSubmissionPayload({ ...payload, evidence: undefined })).toBeUndefined();
		const phishing = await readyPayload({ allegationCategory: "phishing", legalBrandUrl: "https://www.okx.com/" });
		const { legalBrandUrl: _dropped, ...withoutBrand } = phishing.report as Record<string, unknown>;
		expect(storedGnameSubmissionPayload({ ...phishing, report: withoutBrand })).toBeUndefined();
		expect(buildGnameSubmissionPayload({ target: "92haoyun.icu", observedUrl: "https://other.example/", description: "x".repeat(40), allegationCategory: "phishing", legalBrandUrl: CASE_PAGE, evidence: storedGnameSubmissionPayload(payload)!.evidence })).toBeUndefined();
	});

	test("every allegation other than malware files as phishing", () => {
		expect(gnameComplaintKind("malware")).toBe("malware");
		for (const category of ["phishing", "fraud", undefined]) expect(gnameComplaintKind(category)).toBe("phishing");
	});

	test("the preview is the complaint text GNAME receives", () => {
		const preview = gnameProvider.buildReportPreview!({ target: "92haoyun.icu", observedUrls: ["https://92haoyun.icu/"], description: "The page runs an exploit loader in a hidden frame.", allegationCategory: "malware" });
		expect(preview).toStartWith("A suspected malware distribution domain report is being submitted to GNAME for 92haoyun.icu.");
	});

	test("GNAME's case notifications are tied to their route by case number", () => {
		const ids = gnameProvider.inboundMail!.confirmationIds!;
		expect(ids("Your complaint has been submitted successfully! Case No.: GN2026110812345. The system will …")).toEqual(["GN2026110812345"]);
		expect(ids("Case number: 20261108-0001 and again Case No. 20261108-0001")).toEqual(["20261108-0001"]);
		expect(ids("Your case is being processed.")).toEqual([]);
	});
});

describe("mailed verification codes", () => {
	const spec = { ...GNAME_PROVIDER.codeMail, provider: "Test", senderDomains: ["gname.com"], subjectPattern: "verification", codePattern: "code is:?\\s*(\\d{6})\\b" };

	test("only the provider's domain or a subdomain of it sends the code, never a lookalike", () => {
		const mail = (from: string) => mailedCodeFrom(spec, { from, subject: "Email verification", body: "Your code is: 482913" });
		expect(mail("noreply@gname.com")).toBe("482913");
		expect(mail("noreply@mail.gname.com")).toBe("482913");
		expect(mail("NoReply@GNAME.COM")).toBe("482913");
		expect(mail("noreply@evilgname.com")).toBeUndefined();
		expect(mail("noreply@gname.com.evil.example")).toBeUndefined();
		expect(mail("")).toBeUndefined();
	});

	/** GNAME's code mail of 2026-11-07, as it arrived (gname@gname.net through Aliyun DirectMail). */
	const GNAME_SUBJECT = "GNAME: Verify your email address";
	const GNAME_BODY = `<div style='padding:4px 12px 6px 12px;font-family: sans-serif,Verdana, Geneva;'> <div style='height:30px;line-height:30px;font-size:20px;font-weight: bold;color: #003BFC;border-bottom: 2px solid #3AA0EB;padding-bottom:4px;'> GNAME</div> <div style='padding:14px;font-size:14px;min-height:100px;'><div align="left" style="line-height:30px;margin-left:30px;"> Hello,<br/><br/> Here's your verification code: <strong>752253</strong><br/> This code is valid for 10 minutes. Please complete verification soon.<br/> If you didn't request this code, you can safely ignore this email.<br/> <br/> Sincerely,<br/> GNAME Team<br/> </div></div> <div style='color:#d1d1d1;font-size:12px;margin-top:26px;text-align: right;'> Replies sent to this email cannot be answered. For more information,you can contact us.<br/> 请不要回复本邮件. 有任何问题请联系我们.<br/> <span style='color:#157ECB;text-decoration:none;'>www.gname.com</span>&nbsp;&nbsp;&nbsp;2026-11-08 05:39:03+08:00 </div> </div>`;

	test("GNAME's real code mail gives its code, from any sender its help page names", () => {
		const mail = (from: string, subject = GNAME_SUBJECT, body = GNAME_BODY) => mailedCodeFrom(GNAME_PROVIDER.codeMail, { from, subject, body });
		for (const from of ["gname@gname.net", "gname@gname.vip", "noreply@share-dns.net"]) expect(mail(from)).toBe("752253");
		// The plain-text part reads the same.
		expect(mail("gname@gname.net", GNAME_SUBJECT, "Hello, Here's your verification code: 752253 This code is valid for 10 minutes.")).toBe("752253");
		// The date in the footer is no code; a lookalike sender or another mail is no source.
		expect(mail("gname@gname.net", GNAME_SUBJECT, GNAME_BODY.replace("752253", ""))).toBeUndefined();
		expect(mail("noreply@share-dns.network")).toBeUndefined();
		expect(mail("gname@gname.net", "GNAME: Domain renewal notice")).toBeUndefined();
	});

	test("the code is read from HTML with entities and line breaks, and needs the subject", () => {
		expect(mailedCodeFrom(spec, { from: "a@gname.com", subject: "Verification code", body: "<td>Your code is:</td>&nbsp;<td>\n<b>482913</b></td>" })).toBe("482913");
		expect(mailedCodeFrom(spec, { from: "a@gname.com", subject: "Newsletter", body: "Your code is: 482913" })).toBeUndefined();
		expect(mailedCodeFrom(spec, { from: "a@gname.com", subject: "Verification", body: "Your code is: 4829" })).toBeUndefined();
	});
});

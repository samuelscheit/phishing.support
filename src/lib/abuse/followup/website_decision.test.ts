import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import sharp from "sharp";

import { ArtifactsEntity, SubmissionsEntity } from "../../db/entities";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { buildWebsiteEvidence } from "../../evidence/package";
import { capturedDocumentContent, WebsiteCaptureFailedError, WebsiteUnreachableError, type WebsiteArchiveResult } from "../../website_archive";
import type { WebsiteSiteClassification } from "../../website_types";
import { validateAbuseReportRequest } from "../contracts";
import type { sendAbuseEmailRoute } from "../mail";
import { AbuseRepository } from "../repository";
import { defangUrl } from "../../malware/defang";
import { extractTurnstileSitekeys } from "./account_identifiers";
import { followUpProviderDecision } from "./decision";
import type { DecisionReplyInput } from "./reply";

useTemporaryDatabase();

const originalSecret = process.env.ABUSE_TRACKING_TOKEN_SECRET;
beforeAll(() => { process.env.ABUSE_TRACKING_TOKEN_SECRET = "website-decision-follow-up-secret-32b!"; });
afterAll(() => {
	if (originalSecret === undefined) delete process.env.ABUSE_TRACKING_TOKEN_SECRET;
	else process.env.ABUSE_TRACKING_TOKEN_SECRET = originalSecret;
});

/**
 * Production case 376813288618463354: Cloudflare report 67faa5d38a60c855 for
 * docusign.alt3-doc3ea7-v2.sbs was answered "The reported content is no
 * longer visible" at 21:18 UTC; the kit sends datacenter visitors to a news
 * site, and the registry put the domain on clientHold at 21:48.
 */
const URL_REPORTED = "https://docusign.alt3-doc3ea7-v2.sbs/word/verify.workspace.php";
const SITEKEY = "0x4AAAAAADg6vRuzsW0g74ZR";
const CLOAKING = `${URL_REPORTED} sent the Tor exit to aljazeera.com but the residential exit to alt3-doc3ea7-v2.sbs`;
const KIT_PAGE = `<html><head><title>Verify Your Email</title></head><body><div class="card"><h1>Verify Your Email</h1>
<form action="${URL_REPORTED}" method="POST"><label for="email">Email address</label><input type="email" id="email" name="email" placeholder="you@example.com">
<div class="cf-turnstile" data-sitekey="${SITEKEY}"></div><button type="submit">Open</button></form>
<p>Your DocuSign document is ready to review once your email address is confirmed for this secure workspace session.</p></div></body></html>`;
const GMAIL_PAGE = `<html><head><title>Gmail</title></head><body><h1>Sign in</h1><p>to continue to Gmail</p><form action="pass.php" method="POST"><input type="email" name="identifier" placeholder="Email or phone"><input type="password" name="hiddenPassword" style="display:none"><button>Next</button></form></body></html>`;
const DECOY_PAGE = `<html><head><title>Al Jazeera</title></head><body><h1>Breaking news, world news and video from Al Jazeera</h1><p>Live updates from around the world.</p></body></html>`;
const PNG = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#ffffff" } })
	.composite([{ input: { create: { width: 20, height: 10, channels: 3, background: "#202124" } }, top: 10, left: 10 }]).png().toBuffer();

function mhtmlOf(url: string, html: string) {
	return Buffer.from(`From: <Saved by Blink>\r\nSnapshot-Content-Location: ${url}\r\nContent-Type: multipart/related; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html\r\nContent-Location: ${url}\r\n\r\n${html}\r\n--b--\r\n`, "utf8");
}

function capture(url: string, html: string, extra: Partial<WebsiteArchiveResult> = {}): WebsiteArchiveResult {
	const content = capturedDocumentContent(html);
	return {
		requestedUrl: URL_REPORTED,
		url,
		hostname: new URL(url).hostname,
		navigationHops: [{ index: 0, url, hostname: new URL(url).hostname, status: 200, contentType: "text/html", contentCaptured: true }],
		archivedAt: new Date("2026-11-05T22:00:00Z"),
		route: "residential exit",
		screenshotPng: PNG,
		mhtml: mhtmlOf(url, html),
		html: Buffer.from(content.html),
		text: Buffer.from(content.text),
		...extra,
	};
}

let nextCase = 376813288618463354n;

/** A reported, denied phishing case as production holds it: the kit's capture, its cloaking, Cloudflare's "no longer visible". */
async function deniedPhishingCase(options: { capturedAt?: Date; html?: string; url?: string; status?: "reported" | "invalid" } = {}) {
	const submissionId = nextCase++;
	const url = options.url ?? URL_REPORTED;
	const host = new URL(url).hostname;
	await SubmissionsEntity.create({
		id: submissionId,
		kind: "website",
		source: url,
		dedupeKey: `website-${host}`,
		status: options.status ?? "reported",
		data: {
			kind: "website",
			website: {
				url,
				archiveUrl: url,
				cloaking: { outcome: "detected", detail: CLOAKING },
				siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Verify Your Email" }],
			},
		},
	});
	const archive = { ...capture(url, options.html ?? KIT_PAGE, { archivedAt: options.capturedAt ?? new Date("2026-11-05T21:04:45Z") }), requestedUrl: url };
	await ArtifactsEntity.saveWebsiteArtifacts({ submissionId, archive, evidence: await buildWebsiteEvidence({ caseId: submissionId.toString(), step: 0, submittedUrl: url, capturedUrl: url, capturedAt: archive.archivedAt, route: "residential exit", navigationHops: archive.navigationHops, screenshotPng: PNG, mhtml: archive.mhtml }, { timestamp: async () => undefined }) });

	const request = await validateAbuseReportRequest({
		targets: [host],
		allegationCategory: "phishing",
		description: "The page impersonates a trusted brand and asks visitors for sign-in details.",
		observedUrls: [{ target: host, urls: [url] }],
	});
	const report = await AbuseRepository.createReport({ request, reporter: {}, submissionId });
	const [target] = await AbuseRepository.listTargets(report.reportId);
	const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
		routeKey: "provider_submission:cloudflare:contact", providerRegistryKey: "cloudflare", providerDisplayName: "Cloudflare Abuse",
		routeType: "provider_submission", resolverProvenance: { source: "test" }, resolutionSnapshot: { source: "test" }, status: "verified",
	});
	const run = await AbuseRepository.createProviderRun({ routeId: route.id, providerPayload: {}, correlationKey: `cf:${route.id.toString()}` });
	await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId: "67faa5d38a60c855", submittedTargets: [host] });
	await AbuseRepository.recordProviderCorrespondence({ route, messages: [{ id: `response-${submissionId}`, subject: "[67faa5d38a60c855]: Response to your Phishing report", body: "The reported content is no longer visible at the URLs included in your complaint.", sentAt: new Date("2026-11-05T21:18:44Z"), from: "Cloudflare Abuse" }] });
	return { submissionId, reportId: report.reportId, route };
}

function recordingSend() {
	const sent: Array<Parameters<typeof sendAbuseEmailRoute>[0]> = [];
	const send = (async (params) => { sent.push(params); return { messageId: 1n, status: "sent", rfcMessageId: "<x@phishing.support>" }; }) as typeof sendAbuseEmailRoute;
	return { sent, send };
}

const gone = async (): Promise<WebsiteArchiveResult> => {
	throw new WebsiteCaptureFailedError(["phishing", "reporting", "residential"].map((egress) => new WebsiteUnreachableError(egress as "phishing", `net::ERR_TUNNEL_CONNECTION_FAILED at ${URL_REPORTED}`)));
};
const classifiedAs = (classification: WebsiteSiteClassification) => async () => classification;
const PHISHING: WebsiteSiteClassification = { finding: "phishing", phishingBasis: "credential_theft", evidenceQuote: "Verify Your Email" };

describe("account identifiers", () => {
	test("Turnstile sitekeys are found once each, never Cloudflare's published test keys", () => {
		const html = `<div class="cf-turnstile" data-sitekey="${SITEKEY}"></div>
<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/04mhg/${SITEKEY}/light/fbE/new/normal"></iframe>
<div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div><div data-sitekey="3x00000000000000000000FF"></div>`;
		expect(extractTurnstileSitekeys(html)).toEqual([{ kind: "cloudflare_turnstile_sitekey", label: "Cloudflare Turnstile sitekey", value: SITEKEY }]);
		expect(extractTurnstileSitekeys("<p>no widget</p>")).toEqual([]);
	});
});

describe("a phishing site's denial is answered from a recheck of the site", () => {
	test("a site gone everywhere whose kit carries a Turnstile sitekey gets a reply about the Cloudflare account, not a re-review", async () => {
		const { reportId, route } = await deniedPhishingCase();
		const { sent, send } = recordingSend();
		const narratives: DecisionReplyInput[] = [];

		const result = await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "content_removed" }, {
			send,
			now: () => new Date("2026-11-05T22:30:00Z"),
			website: { capture: gone, classify: async () => { throw new Error("nothing to classify"); } },
			writeNarrative: async (input) => { narratives.push(input); return undefined; },
		});

		expect(result).toBe("sent");
		expect(narratives[0]!.replyKind).toBe("account");
		expect(narratives[0]!.evidence).toMatchObject({
			kind: "website",
			stillServed: false,
			recheck: { reached: false },
			reportedCloaking: CLOAKING,
			accountIdentifiers: [{ value: SITEKEY }],
			capture: { url: URL_REPORTED, afterReview: false, quote: "Verify Your Email", timestamped: false },
		});
		expect(sent[0]).toMatchObject({ recipient: "abusereply@cloudflare.com", subject: "[67faa5d38a60c855] Additional evidence for abuse report 67faa5d38a60c855" });
		const body = sent[0]!.body;
		expect(body).toStartWith("Hello Cloudflare Trust & Safety,\n\nThis is about report 67faa5d38a60c855 (docusign.alt3-doc3ea7-v2.sbs).");
		expect(body).toContain("The site cloaks:");
		expect(body).toContain("Please review that account.");
		expect(body).not.toContain("review the report again");
		expect(body).toContain("no longer answers on any route (Failed to load page: net::ERR_TUNNEL_CONNECTION_FAILED");
		expect(body).toContain(`- Cloudflare Turnstile sitekey: ${SITEKEY}`);
		expect(body).toContain(`Our capture: ${defangUrl(URL_REPORTED)} at 2026-11-05T21:04:45.000Z, showing "Verify Your Email".`);
		// Every URL and hostname in the reply is defanged.
		expect(body).not.toMatch(/https?:\/\/(?!phishing\.support)|aljazeera\.com/);
		// The report's own evidence goes along; there is no fresh screenshot of a gone site.
		expect(sent[0]!.attachments!.map(({ filename }) => filename)).not.toContain("recheck-stamped.png");
		const events = await AbuseRepository.listEvents(reportId);
		expect(events.find((event) => event.eventType === "provider_decision.followed_up")?.data).toMatchObject({ replyKind: "account", narrative: "fallback" });
	});

	test("a kit still served to the residential exit is contested with the cloaking and a fresh stamped screenshot", async () => {
		const { route } = await deniedPhishingCase();
		const { sent, send } = recordingSend();
		const narratives: DecisionReplyInput[] = [];
		const freshKit = async () => capture(URL_REPORTED, KIT_PAGE, { cloaking: { outcome: "detected", detail: CLOAKING } });

		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "content_removed" }, {
			send,
			now: () => new Date("2026-11-05T22:30:00Z"),
			website: { capture: freshKit, classify: classifiedAs(PHISHING), timestamp: async () => undefined },
			writeNarrative: async (input) => {
				narratives.push(input);
				return "Your reviewer most likely visited from a datacenter connection, which this site sends to aljazeera.com by script. Our residential recheck still reaches the phishing page, which asks for the visitor's email address before its sign-in step, and a screenshot of it is attached. Please review the report again.";
			},
		})).toBe("sent");

		expect(narratives[0]!.replyKind).toBe("contest");
		expect(narratives[0]!.evidence).toMatchObject({ stillServed: true, recheck: { reached: true, route: "residential exit", matchesReportedKit: true } });
		const body = sent[0]!.body;
		expect(body).toContain("Your reviewer most likely visited from a datacenter connection, which this site sends to aljazeera[.]com by script.");
		expect(body).toContain(`ended on ${defangUrl(URL_REPORTED)} (residential exit): the phishing page is still served; it shows "Verify Your Email".`);
		expect(body).toContain("- How it answered the routes: hxxps://docusign[.]alt3-doc3ea7-v2[.]sbs/word/verify[.]workspace[.]php sent the Tor exit to aljazeera[.]com but the residential exit to alt3-doc3ea7-v2[.]sbs.");
		expect(body).toContain("Attached: recheck-stamped.png");
		expect(sent[0]!.attachments![0]).toMatchObject({ filename: "recheck-stamped.png", mimeType: "image/png" });
		expect(sent[0]!.attachments!.length).toBeLessThanOrEqual(5);
	});

	test("a kit whose recheck lands on its email gate counts as still served when the page is the one we reported", async () => {
		const { route } = await deniedPhishingCase();
		const { sent, send } = recordingSend();
		// The classifier answers the gate as needing its next step, not as phishing by itself.
		const gate = { finding: "insufficient_evidence" } as WebsiteSiteClassification;
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "no_abuse_found" }, {
			send,
			website: { capture: async () => capture(URL_REPORTED, KIT_PAGE), classify: classifiedAs(gate), timestamp: async () => undefined },
			writeNarrative: async () => undefined,
		})).toBe("sent");
		expect(sent[0]!.body).toContain("the phishing page is still served");
		expect(sent[0]!.body).toContain("Please review the report again.");
	});

	test("a recheck that only reaches the decoy, with nothing else to show, is not contested", async () => {
		const { reportId, route } = await deniedPhishingCase({ html: KIT_PAGE.replace(`data-sitekey="${SITEKEY}"`, "") });
		const { sent, send } = recordingSend();
		const decoy = async () => capture("https://www.aljazeera.com/", DECOY_PAGE, { route: "residential exit", cloaking: { outcome: "uniform", detail: `${URL_REPORTED} sent both the Tor exit and the residential exit to aljazeera.com by script` } });
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "content_removed" }, {
			send,
			website: { capture: decoy, classify: classifiedAs({ finding: "benign" }) },
			writeNarrative: async () => undefined,
		})).toBe("skipped");
		expect(sent).toEqual([]);
		const event = (await AbuseRepository.listEvents(reportId)).find((item) => item.eventType === "provider_decision.not_contested");
		expect(event?.data).toMatchObject({ state: "denied", detail: "content_removed", recheck: { stillServed: false, recheck: { reached: true, url: "https://www.aljazeera.com/" }, accountIdentifiers: [] } });
	});

	test("a sibling host's sitekey on the same domain ties a gone site to the account, credited to the host it was found on", async () => {
		// workspace.alt3-doc3ea7-v2.sbs (report 416165dbaf260a63): its stored page is the
		// Gmail clone, without the Turnstile widget docusign.'s email gate carries.
		await deniedPhishingCase();
		const workspaceUrl = "https://workspace.alt3-doc3ea7-v2.sbs/workspace/drive/";
		const { route } = await deniedPhishingCase({ html: GMAIL_PAGE, url: workspaceUrl });
		const { sent, send } = recordingSend();
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "content_removed" }, { send, website: { capture: gone }, writeNarrative: async () => undefined })).toBe("sent");
		expect(sent[0]!.body).toContain(`- Cloudflare Turnstile sitekey: ${SITEKEY} (in the pages of docusign[.]alt3-doc3ea7-v2[.]sbs)`);
		expect(sent[0]!.body).toContain("Please review that account.");
	});

	test("a sitekey on another domain, or on an unconfirmed case, is never borrowed", async () => {
		await deniedPhishingCase({ url: "https://docusign.other-kit.sbs/word/verify.workspace.php" });
		await deniedPhishingCase({ url: "https://drive.alt4-unrelated.sbs/", status: "invalid" });
		const { route } = await deniedPhishingCase({ html: GMAIL_PAGE, url: "https://workspace.alt4-unrelated.sbs/workspace/drive/" });
		const { sent, send } = recordingSend();
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied" }, { send, website: { capture: gone }, writeNarrative: async () => undefined })).toBe("skipped");
		expect(sent).toEqual([]);
	});

	test("a site gone everywhere with no account identifiers and no capture after the review is not contested", async () => {
		const { route } = await deniedPhishingCase({ html: KIT_PAGE.replace(`data-sitekey="${SITEKEY}"`, "") });
		const { sent, send } = recordingSend();
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied" }, { send, website: { capture: gone }, writeNarrative: async () => undefined })).toBe("skipped");
		expect(sent).toEqual([]);
	});

	test("our capture after the review contests \"no longer visible\" even when the site has died since", async () => {
		const { route } = await deniedPhishingCase({ html: KIT_PAGE.replace(`data-sitekey="${SITEKEY}"`, ""), capturedAt: new Date("2026-11-05T21:30:00Z") });
		const { sent, send } = recordingSend();
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied", detail: "content_removed" }, { send, website: { capture: gone }, writeNarrative: async () => undefined })).toBe("sent");
		const body = sent[0]!.body;
		expect(body).toContain("Our capture below was made after your review and shows the phishing page was still visible then.");
		expect(body).toContain("at 2026-11-05T21:30:00.000Z, after your review");
	});

	test("a malware report from a case keeps the paste-command check, never a site recheck", async () => {
		const submissionId = nextCase++;
		await SubmissionsEntity.create({ id: submissionId, kind: "website", source: "https://paneo.work/", dedupeKey: `website-${submissionId}`, status: "reported", data: { kind: "website", website: { url: "https://paneo.work/" } } });
		const request = await validateAbuseReportRequest({ targets: ["paneo.work"], allegationCategory: "malware", description: "The page distributes malware.", observedUrls: [{ target: "paneo.work", urls: ["https://paneo.work/"] }] });
		const report = await AbuseRepository.createReport({ request, reporter: {}, submissionId });
		const [target] = await AbuseRepository.listTargets(report.reportId);
		const route = await AbuseRepository.upsertResolvedRoute(target!.id, {
			routeKey: "provider_submission:cloudflare:contact", providerRegistryKey: "cloudflare", providerDisplayName: "Cloudflare Abuse",
			routeType: "provider_submission", resolverProvenance: { source: "test" }, resolutionSnapshot: { source: "test" }, status: "verified",
		});
		const run = await AbuseRepository.createProviderRun({ routeId: route.id, providerPayload: {}, correlationKey: `cf:${route.id.toString()}` });
		await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "completed", routeStatus: "submitted", confirmationId: "35b8aafac3a6a6d9", submittedTargets: ["paneo.work"] });
		const fetched: string[] = [];
		expect(await followUpProviderDecision({ routeId: route.id, state: "denied" }, {
			fetcher: async (url) => { fetched.push(url); throw new Error("The payload host answered HTTP 404."); },
			website: { capture: async () => { throw new Error("a malware report is never rechecked as a phishing site"); } },
			writeNarrative: async () => undefined,
		})).toBe("skipped");
		expect(fetched).toEqual(["https://paneo.work/"]);
	});
});

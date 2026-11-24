import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";

import { getDb } from "../db";
import { validateAbuseReportRequest } from "../abuse/contracts";
import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import type { WebsiteSubmissionData } from "../db/schema";
import { useTemporaryDatabase } from "../db/test_helpers";
import { AbuseRepository } from "../abuse/repository";
import { abuseJobs } from "../abuse/schema";
import { useTrackingTokenSecret } from "../abuse/security/test_helpers";
import { reportExfiltrationBackend } from "../exfiltration/reporting";
import type { ExfiltrationBackend } from "../exfiltration/types";
import type { WebsiteNavigationHop, WebsiteSiteAssessment } from "../website/types";
import { extractIndicators, type IndicatorDependencies } from "./indicators";
import { linkSiteMember, type LinkDependencies } from "./link";
import { judgedSitePage, memberKey, sitePageSteps, type CampaignSite } from "./members";
import { getPublicCampaign } from "./public_view";
import { linkJobKey, queueCaseSiteLinks } from "./queue";
import { CampaignRepository } from "./repository";
import { campaignIndicators, campaignMembers } from "./schema";
import { enqueueCampaignSweep, linkSiteToCampaign } from "./sweep";
import { confirmedCase, reportCaseSite } from "./test_sites";

useTemporaryDatabase();
useTrackingTokenSecret();

const IBAN = "DE89 3704 0044 0532 0130 00";
const WALLET = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const KIT = "a".repeat(64);
const LURE = "https://lure-a-test.com/start";
const KIT_PAGE = "https://kit-b-test.com/login";
const BRAND = { name: "Example Bank", officialUrl: "https://www.example-bank.test/" };

const hop = (index: number, url: string, extra: Partial<WebsiteNavigationHop> = {}): WebsiteNavigationHop => ({ index, url, hostname: new URL(url).hostname, status: 200, contentCaptured: false, ...extra });

/**
 * A chain that confirmed two sites: the lure's own page (step 0, the
 * headline page, which the visit moved on from) and the kit's page it led
 * to (step 1). The lure asks for a bank transfer, the kit for a crypto
 * payment and offers a file; the capture's kit files and the server lookup
 * are the lure's.
 */
function twoSiteChain(): WebsiteSubmissionData {
	const assessments: WebsiteSiteAssessment[] = [
		{ hopIndex: 0, judgedHopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", impersonatedBrand: BRAND, evidenceQuote: "Sign in to Example Bank" },
		{ hopIndex: 1, judgedHopIndex: 1, finding: "phishing", phishingBasis: "payment_fraud", evidenceQuote: "Pay the release fee" },
	];
	return {
		url: LURE,
		archiveUrl: LURE,
		analyzedHopIndex: 0,
		navigationHops: [hop(0, LURE, { visitorStep: { submitted: [] }, redirectTo: KIT_PAGE }), hop(1, KIT_PAGE, { contentCaptured: true })],
		siteAssessments: assessments,
		kitResources: [{ url: "https://lure-a-test.com/kit.js", mimeType: "application/javascript", size: 40_000, sha256: KIT }],
		offeredDownload: { pageUrl: KIT_PAGE, url: "https://kit-b-test.com/Release.exe", fileName: "Release.exe", sizeBytes: 9_000, sha256: "d".repeat(64), userAgent: "test", inspection: {} as never },
		whois: { ip_rdaps: [{ ip: "203.0.113.7", name: "EXAMPLE-NET", country: "NL", origin_asns: [], abuse: null }] } as never,
	};
}

/** A one-page case of one site whose page says `text`. */
const onePage = (url: string): WebsiteSubmissionData => ({ url, siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "payment_fraud" }] });

/** What each case's captured pages read, by capture file. */
const pageTexts: Record<string, Array<{ name: string; text: string }>> = {};

const offline: LinkDependencies = {
	loadBackends: async () => [],
	loadPageTexts: async (submissionId) => pageTexts[submissionId.toString()] ?? [],
	libraryFor: async () => undefined,
	isPlatformHost: async () => false,
	loadPopularDomains: async () => new Set(),
	loadPageFingerprints: async () => ({}),
	saveThumbnail: async () => undefined,
};

/** The two-site case 1, a case 2 sharing the lure's bank account, a case 3 sharing the kit's wallet. */
async function chainAndPeers() {
	pageTexts["1"] = [
		{ name: "website.mhtml", text: `Da die Zugänglichkeit Ihres Kontos eingeschränkt ist, bitten wir Sie, die Gebühr auf das Konto ${IBAN} zu überweisen und danach Ihre Daten erneut einzugeben, damit wir Ihr Konto entsperren können.` },
		{ name: "website-step2.mhtml", text: `Your parcel is waiting at our depot. To release it, please send the small release fee to the wallet ${WALLET} and keep this page open until the payment has been confirmed by our team.` },
	];
	pageTexts["2"] = [{ name: "website.mhtml", text: `Überweisen Sie an ${IBAN}.` }];
	pageTexts["3"] = [{ name: "website.mhtml", text: `Pay ${WALLET} to continue.` }];
	const [lure, kit] = await confirmedCase(1n, twoSiteChain(), { sites: [LURE, KIT_PAGE] });
	const [bank] = await confirmedCase(2n, onePage("https://iban-c-test.com/"));
	const [wallet] = await confirmedCase(3n, onePage("https://wallet-d-test.com/"));
	return { lure: lure!, kit: kit!, bank: bank!, wallet: wallet! };
}

const linkAll = async (members: readonly CampaignSite[], dependencies: LinkDependencies = offline) => {
	for (const member of members) await linkSiteMember(member, dependencies);
};
const campaignOf = (member: CampaignSite) => CampaignRepository.campaignForMember(member);
const rowCount = async (table: typeof campaignMembers | typeof campaignIndicators) => Number((await getDb()).select({ count: sql<number>`count(*)` }).from(table).get()!.count);
const linkJobs = async () => (await getDb()).select().from(abuseJobs).where(eq(abuseJobs.jobType, "link_campaign")).all();

describe("a chain's sites as members", () => {
	test("each site of a chain is judged by its own page: its step, its pages, its judged page", () => {
		const chain = twoSiteChain();
		expect(judgedSitePage(chain, "lure-a-test.com")).toEqual({ url: LURE, step: 0 });
		expect(judgedSitePage(chain, "kit-b-test.com")).toEqual({ url: KIT_PAGE, step: 1 });
		expect(judgedSitePage(chain, "elsewhere-test.com")).toBeUndefined();
		expect(sitePageSteps(chain, "lure-a-test.com")).toEqual([0]);
		expect(sitePageSteps(chain, "kit-b-test.com")).toEqual([1]);
		// A case without a recorded chain showed its one site every page.
		expect(sitePageSteps(onePage("https://solo-test.com/"), "solo-test.com")).toBeUndefined();
		expect(sitePageSteps(onePage("https://solo-test.com/"), "other-test.com")).toEqual([]);
		expect(judgedSitePage(onePage("https://solo-test.com/x"), "solo-test.com")).toEqual({ url: "https://solo-test.com/x", step: 0 });
	});

	test("a case whose chain confirmed two sites is a member for each, in the campaign each site's own evidence puts it in", async () => {
		const { lure, kit, bank, wallet } = await chainAndPeers();
		expect(lure.reportId).not.toBe(kit.reportId);
		await linkAll([lure, kit, bank, wallet]);

		const bankCampaign = (await campaignOf(lure))!;
		const walletCampaign = (await campaignOf(kit))!;
		expect(bankCampaign).not.toBe(walletCampaign);
		expect(await campaignOf(bank)).toBe(bankCampaign);
		expect(await campaignOf(wallet)).toBe(walletCampaign);
		expect(await CampaignRepository.listCaseMemberships(1n)).toEqual([
			{ submissionId: 1n, reportId: lure.reportId, campaignId: bankCampaign },
			{ submissionId: 1n, reportId: kit.reportId, campaignId: walletCampaign },
		]);

		const [lureView] = await CampaignRepository.listMembers(bankCampaign);
		const [kitView] = await CampaignRepository.listMembers(walletCampaign);
		expect(lureView).toMatchObject({ submissionId: 1n, reportId: lure.reportId, site: "lure-a-test.com", url: LURE, pageStep: 0 });
		expect(kitView).toMatchObject({ submissionId: 1n, reportId: kit.reportId, site: "kit-b-test.com", url: KIT_PAGE, pageStep: 1 });
		// What the case recorded once for its headline page (kit files, the submitted address's server) is the lure's alone;
		// the offered file is the kit page's.
		const shown = (view: typeof lureView) => view!.indicators.map(({ kind, value }) => `${kind} ${value}`).sort();
		expect(shown(lureView)).toEqual([`kit_fingerprint ${KIT}`, "origin_ip 203.0.113.7", "payment_receiver iban:DE89370400440532013000"]);
		expect(shown(kitView)).toEqual(["operator_server host:kit-b-test.com", `payment_receiver tron:${WALLET}`]);
	});

	test("a case showing both sites' evidence makes the chain's two members one campaign, the case in it twice", async () => {
		const { lure, kit, bank, wallet } = await chainAndPeers();
		await linkAll([lure, kit, bank, wallet]);
		const [older, newer] = [(await campaignOf(lure))!, (await campaignOf(kit))!].sort((a, b) => (a < b ? -1 : 1));
		pageTexts["4"] = [{ name: "website.mhtml", text: `Pay ${IBAN} or ${WALLET}.` }];
		const [bridge] = await confirmedCase(4n, onePage("https://bridge-test.com/"));
		await linkSiteMember(bridge!, offline);

		expect(await campaignOf(lure)).toBe(older!);
		expect(await campaignOf(kit)).toBe(older!);
		expect((await CampaignRepository.getCampaign(newer!))?.mergedInto).toBe(older!);
		const members = await CampaignRepository.listMembers(older!);
		expect(members.map((member) => [member.submissionId, member.url])).toEqual([[1n, LURE], [1n, KIT_PAGE], [2n, "https://iban-c-test.com/"], [3n, "https://wallet-d-test.com/"], [4n, "https://bridge-test.com/"]]);
		expect(await CampaignRepository.memberCount(older!)).toBe(5);
		const [summary] = await CampaignRepository.listCampaigns();
		expect(summary).toMatchObject({ memberCount: 5, linkingIndicators: { payment_receiver: 2 }, sampleUrls: [LURE, KIT_PAGE, "https://iban-c-test.com/"] });
		// The case's page links to its campaign once.
		expect((await CampaignRepository.listCaseMemberships(1n)).map((membership) => membership.campaignId)).toEqual([older!, older!]);
	});

	test("linking every member again, in any order, changes nothing: no member, indicator or campaign is added", async () => {
		const { lure, kit, bank, wallet } = await chainAndPeers();
		await linkAll([lure, kit, bank, wallet]);
		const before = { campaigns: await Promise.all([lure, kit, bank, wallet].map(campaignOf)), members: await rowCount(campaignMembers), indicators: await rowCount(campaignIndicators) };
		await linkAll([wallet, kit, lure, bank, kit, lure]);
		expect({ campaigns: await Promise.all([lure, kit, bank, wallet].map(campaignOf)), members: await rowCount(campaignMembers), indicators: await rowCount(campaignIndicators) }).toEqual(before);
		expect(before.members).toBe(4);
		expect((await CampaignRepository.listCampaigns()).map((summary) => summary.memberCount).sort()).toEqual([2, 2]);
	});

	test("each site keeps the preview of its own judged page", async () => {
		const { lure, kit } = await chainAndPeers();
		const white = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#ffffff" } }).png().toBuffer();
		const card = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#2563eb" } }).png().toBuffer();
		await ArtifactsEntity.saveBuffer({ submissionId: 1n, name: "website.png", kind: "website_png", mimeType: "image/png", buffer: white });
		await ArtifactsEntity.saveBuffer({ submissionId: 1n, name: "website-step2.png", kind: "website_png", mimeType: "image/png", buffer: await sharp(white).composite([{ input: card, left: 100, top: 100 }]).png().toBuffer() });
		const real = { ...offline, saveThumbnail: undefined };
		await linkAll([lure, kit, lure, kit], real);

		const [lureFacts, kitFacts] = await CampaignRepository.listSiteFacts([lure, kit]);
		// Each site speaks its own pages' language.
		expect(lureFacts).toMatchObject({ reportId: lure.reportId, blankCapture: true, language: "de" });
		expect(kitFacts).toMatchObject({ reportId: kit.reportId, blankCapture: false, language: "en" });
		const previews = (await ArtifactsEntity.listForSubmission(1n)).filter((artifact) => artifact.kind === "website_thumbnail");
		expect(previews.map((artifact) => artifact.name).sort()).toEqual(["website-step2-thumb.webp", "website-thumb.webp"]);
		expect(previews.find((artifact) => artifact.name === "website-thumb.webp")!.id).toBe(lureFacts!.thumbnailArtifactId!);
		expect(previews.find((artifact) => artifact.name === "website-step2-thumb.webp")!.id).toBe(kitFacts!.thumbnailArtifactId!);
	});

	test("the public page shows each site with its own picture, pages, verdict and report", async () => {
		const { lure, kit } = await chainAndPeers();
		for (const name of ["website.png", "website-stamped.png", "website-step2.png", "website-step2-stamped.png"]) {
			await ArtifactsEntity.saveBuffer({ submissionId: 1n, name, kind: "website_png", mimeType: "image/png", buffer: Buffer.from(name) });
		}
		// Both sites share one bot: one campaign with the case in it twice.
		const bot = { kind: "operator_server" as const, value: "telegram-bot:7001", links: true, evidence: { roles: ["receives_data"], backendKind: "telegram_bot" } };
		await CampaignRepository.recordIndicators(lure, [bot]);
		const campaignId = (await CampaignRepository.recordIndicators(kit, [bot]))!;
		const view = (await getPublicCampaign(campaignId))!;
		const files = new Map((await ArtifactsEntity.listForSubmission(1n)).map((artifact) => [`/api/artifacts/${artifact.id.toString()}`, artifact.name]));
		expect(view.sites.map((site) => ({
			key: site.key,
			host: site.host,
			screenshot: files.get(site.screenshotUrl!),
			steps: site.steps.map((step) => [step.step, files.get(step.screenshotUrl), files.get(step.stampedUrl!)]),
			verdict: site.verdict && [site.verdict.basis, site.verdict.impersonates],
		}))).toEqual([
			{ key: memberKey(lure), host: "lure-a-test.com", screenshot: "website-stamped.png", steps: [[1, "website.png", "website-stamped.png"]], verdict: ["credential_theft", "Example Bank"] },
			{ key: memberKey(kit), host: "kit-b-test.com", screenshot: "website-step2-stamped.png", steps: [[2, "website-step2.png", "website-step2-stamped.png"]], verdict: ["payment_fraud", undefined] },
		]);
		expect(view.reasons.map((reason) => reason.kind)).toEqual(["same_backend"]);
	});
});

describe("a case that joined another case's report", () => {
	/** Case 2 reached the kit page case 1 reported through a shortener: it joins case 1's report of the site. */
	async function joinedCase() {
		pageTexts["1"] = [{ name: "website.mhtml", text: `Transfer the fee to ${IBAN}.` }];
		pageTexts["2"] = [{ name: "website.mhtml", text: `Send the fee to ${WALLET}.` }];
		pageTexts["3"] = [{ name: "website.mhtml", text: `Pay ${WALLET} to continue.` }];
		const [owner] = await confirmedCase(1n, { ...onePage(KIT_PAGE), kitResources: [{ url: "https://kit-b-test.com/kit.js", mimeType: "application/javascript", size: 40_000, sha256: KIT }] });
		const chain: WebsiteSubmissionData = {
			url: "https://short-z-test.link/x",
			archiveUrl: KIT_PAGE,
			analyzedHopIndex: 1,
			navigationHops: [hop(0, "https://short-z-test.link/x", { status: 302, redirectTo: KIT_PAGE }), hop(1, KIT_PAGE, { contentCaptured: true })],
			siteAssessments: [{ hopIndex: 0, finding: "insufficient_evidence" }, { hopIndex: 1, judgedHopIndex: 1, finding: "phishing", phishingBasis: "payment_fraud" }],
			kitResources: [{ url: "https://kit-b-test.com/kit.js", mimeType: "application/javascript", size: 40_000, sha256: KIT }],
			whois: { ip_rdaps: [{ ip: "198.51.100.9", name: "SHORTENER", country: "US", origin_asns: [], abuse: null }] } as never,
		};
		const [joiner] = await confirmedCase(2n, chain, { sites: [KIT_PAGE] });
		const [wallet] = await confirmedCase(3n, onePage("https://wallet-d-test.com/"));
		return { owner: owner!, joiner: joiner!, wallet: wallet! };
	}

	test("is a member through the report it joined, with what its own capture of the site shows", async () => {
		const { owner, joiner, wallet } = await joinedCase();
		expect(joiner.reportId).toBe(owner.reportId);
		expect((await AbuseRepository.listJoinedReportsForSubmission(2n)).map((report) => report.id)).toEqual([owner.reportId]);
		expect(await AbuseRepository.listReportsForSubmission(2n)).toEqual([]);
		expect(await CampaignRepository.listCaseSites(2n)).toEqual([{ submissionId: 2n, reportId: owner.reportId }]);
		expect(await CampaignRepository.siteOf(joiner)).toBe("kit-b-test.com");

		// Confirmed and reported, it is a member before its own link runs.
		await linkSiteMember(owner, offline);
		expect(await campaignOf(joiner)).toBeDefined();

		await linkAll([joiner, wallet]);
		// Its page asks for the wallet case 3's asks for, unlike the owner's: it is in case 3's campaign, through the owner's report.
		expect(await campaignOf(joiner)).toBe((await campaignOf(wallet))!);
		const [, joinerView] = await CampaignRepository.listMembers((await campaignOf(joiner))!);
		expect(joinerView).toMatchObject({ submissionId: 2n, reportId: owner.reportId, site: "kit-b-test.com", url: KIT_PAGE, pageStep: 0 });
		// Its kit files are its headline page's, the kit page; the shortener's server is not the site's.
		expect(joinerView!.indicators.map(({ kind, value }) => `${kind} ${value}`).sort()).toEqual([`kit_fingerprint ${KIT}`, `payment_receiver tron:${WALLET}`]);
		// The kit file links the owner too: owner, joiner and case 3 are one campaign, the site in it twice.
		expect(await campaignOf(owner)).toBe((await campaignOf(joiner))!);
	});

	test("is linked when it joins, is swept with every other site, and a resolution of the owner's report links only the owner", async () => {
		const { owner, joiner, wallet } = await joinedCase();
		expect(await queueCaseSiteLinks(2n)).toBe(1);
		expect((await linkJobs()).map((job) => ({ key: job.dedupeKey, reportId: job.reportId, payload: job.payload }))).toEqual([
			{ key: `campaign-link:2:${owner.reportId.toString()}`, reportId: owner.reportId, payload: { submissionId: "2" } },
		]);
		const now = new Date("2026-11-20T00:00:00Z");
		expect(await enqueueCampaignSweep("manual", now)).toBe(3);
		const swept = (await linkJobs()).filter((job) => job.dedupeKey?.startsWith("campaign-link:manual:"));
		expect(swept.map((job) => job.dedupeKey)).toEqual([owner, joiner, wallet].map((member) => linkJobKey(member, "manual")));
		expect(swept.map((job) => job.nextAttemptAt.getTime() - now.getTime())).toEqual([0, 20_000, 40_000]);
		expect(await queueCaseSiteLinks(1n)).toBe(1);
		expect((await linkJobs()).filter((job) => job.dedupeKey === linkJobKey(owner))).toHaveLength(1);
	});
});

describe("linking a site's report", () => {
	const bot = (botId: string): ExfiltrationBackend => ({
		kind: "telegram_bot",
		key: `telegram:${botId}`,
		endpointUrl: `https://api.telegram.org/bot${botId}:AAE/sendMessage`,
		hostname: "api.telegram.org",
		method: "POST",
		matchedCanaries: ["email"],
		request: { timestamp: "2026-11-10T08:00:00.000Z", url: `https://api.telegram.org/bot${botId}:AAE/sendMessage`, method: "POST" },
		telegram: { token: `${botId}:AAEsecret`, botId, chatId: "-1001" },
	});

	test("a data drop goes with the site whose report's investigation found it; its own report links nothing, and its resolution links every site again", async () => {
		const { lure, kit } = await chainAndPeers();
		const drop = await reportExfiltrationBackend({ submissionId: 1n, sourceReportId: kit.reportId, backend: bot("7001"), pageUrl: KIT_PAGE, observedAt: new Date("2026-11-10T08:00:00Z"), reporter: {} });
		const { loadBackends: _fixture, ...realBackends } = offline as IndicatorDependencies;
		const servers = async (member: CampaignSite) => (await extractIndicators(member, realBackends)).filter((indicator) => indicator.kind === "operator_server").map((indicator) => indicator.value);
		expect(await servers(lure)).toEqual([]);
		expect(await servers(kit)).toEqual(["telegram-bot:7001", "host:kit-b-test.com"]);

		expect(await CampaignRepository.siteOf({ submissionId: 1n, reportId: drop.reportId })).toBeUndefined();
		expect(await linkSiteToCampaign({ submissionId: 1n, reportId: drop.reportId }, offline)).toBeUndefined();
		expect(await CampaignRepository.listCaseMemberships(1n)).toEqual([]);

		expect(await queueCaseSiteLinks(1n)).toBe(2);
		expect((await linkJobs()).map((job) => [job.dedupeKey, job.reportId])).toEqual([[linkJobKey(lure), lure.reportId], [linkJobKey(kit), kit.reportId]]);
	});

	test("only the case's headline site fills in kit files from urlscan; another site of the chain never asks", async () => {
		const chain = { ...twoSiteChain(), kitResources: undefined };
		const [lure, kit] = await confirmedCase(1n, chain, { sites: [LURE, KIT_PAGE] });
		const asked: string[] = [];
		const fetch = async (url: string) => {
			asked.push(url);
			throw new Error("urlscan unreachable");
		};
		expect(await linkSiteToCampaign(kit!, { ...offline, apiKey: "test", fetch })).toBeDefined();
		expect(asked).toEqual([]);
		expect(await linkSiteToCampaign(lure!, { ...offline, apiKey: "test", fetch })).toBeDefined();
		expect(asked.length).toBeGreaterThan(0);
		expect((await AbuseRepository.listEvents(lure!.reportId)).filter((event) => event.eventType === "kit_backfill.checked").map((event) => event.data.kind)).toEqual(["failed"]);
		expect((await AbuseRepository.listEvents(kit!.reportId)).filter((event) => event.eventType === "kit_backfill.checked")).toEqual([]);
	});

	test("an email case's report is no site: it queues and links nothing", async () => {
		await SubmissionsEntity.create({ id: 9n, kind: "email", data: { kind: "email", email: {} } as never, dedupeKey: "email-9", status: "reported" });
		const request = await validateAbuseReportRequest({ targets: ["mail-test.com"], allegationCategory: "phishing", description: "Phishing mail.", observedUrls: [{ target: "mail-test.com", urls: ["https://mail-test.com/"] }] });
		const { reportId } = await AbuseRepository.createReport({ request, reporter: {}, submissionId: 9n });
		expect(await CampaignRepository.listCaseSites(9n)).toEqual([]);
		expect(await queueCaseSiteLinks(9n)).toBe(0);
		expect(await linkSiteToCampaign({ submissionId: 9n, reportId }, offline)).toBeUndefined();
		expect(await CampaignRepository.listConfirmedSites()).toEqual([]);
	});

	test("the second site report of a case is its own, not a replay of the first; the same site again is the same report", async () => {
		await confirmedCase(1n, twoSiteChain(), { sites: [LURE, KIT_PAGE] });
		const again = await reportCaseSite(1n, KIT_PAGE);
		expect((await CampaignRepository.listCaseSites(1n)).map((member) => member.reportId)).toHaveLength(2);
		expect((await CampaignRepository.listCaseSites(1n)).map((member) => member.reportId)).toContain(again.reportId);
	});
});

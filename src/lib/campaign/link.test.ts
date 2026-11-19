import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { ArtifactsEntity } from "../db/entities/artifacts";
import { SubmissionsEntity } from "../db/entities/submissions";
import type { Submission } from "../db/schema";
import { useTemporaryDatabase } from "../db/test_helpers";
import type { ExfiltrationBackend } from "../exfiltration/types";
import type { WebsiteKitResource, WebsiteSiteAssessment } from "../website_types";
import type { GuidanceDependencies, GuidanceInput } from "./guidance";
import { backendIndicatorValue, extractIndicators, lookupPublishedLibrary } from "./indicators";
import { describeCampaignIfChanged, linkSubmissionToCampaign, type LinkDependencies } from "./link";
import type { DescribeDependencies } from "./summary";
import { CampaignRepository } from "./repository";
import { kitCapture } from "./test_mhtml";

useTemporaryDatabase();

const KIT = "1".repeat(64);
const JQUERY = "2".repeat(64);
const CDN_SCRIPT = "3".repeat(64);
const STYLE = "4".repeat(64);
const SMALL = "5".repeat(64);
const OTHER_KIT = "6".repeat(64);
const PLATFORM_FILE = "7".repeat(64);

const resource = (url: string, sha256: string, mimeType = "application/javascript", size = 20_000): WebsiteKitResource => ({ url, sha256, mimeType, size });

function botBackend(botId: string): ExfiltrationBackend {
	return {
		kind: "telegram_bot",
		key: `telegram:${botId}`,
		endpointUrl: `https://api.telegram.org/bot${botId}:AAE/sendMessage`,
		hostname: "api.telegram.org",
		method: "POST",
		matchedCanaries: ["email", "password"],
		request: { timestamp: "2026-11-10T08:00:00.000Z", url: `https://api.telegram.org/bot${botId}:AAE/sendMessage`, method: "POST" },
		telegram: { token: `${botId}:AAEsecret`, botId, chatId: "-1001" },
	};
}

function website(id: bigint, host: string, kitResources: WebsiteKitResource[] = []): Submission {
	return {
		id,
		kind: "website",
		source: null,
		data: { kind: "website", website: { url: `https://${host}/`, kitResources, whois: { ip_rdaps: [{ ip: "203.0.113.7", name: "EXAMPLE-NET", country: "NL", origin_asns: [{ asn: 64500, source: "ripe-stat" }], abuse: null } as never] } } },
		dedupeKey: host,
		status: "reported",
		info: null,
		reporterIp: null,
		reporterCountry: null,
		reporterHeaders: null,
		createdAt: new Date(Number(id) * 1000),
		updatedAt: new Date(Number(id) * 1000),
	};
}

/** Stored submissions with what their investigation and capture showed. */
/** The model's heading for every campaign; a test never reaches a real model. */
const heading: DescribeDependencies = { generate: async () => ({ title: "Fake test notice campaign", summary: "Several look-alike test pages ask for passwords and run the same code, so one operator runs them." }) };

function fixtures(sites: Record<string, { submission: Submission; backends?: ExfiltrationBackend[]; text?: string }>): LinkDependencies & DescribeDependencies {
	const byId = new Map(Object.values(sites).map((site) => [site.submission.id, site]));
	return {
		loadSubmission: async (id) => byId.get(id)?.submission,
		loadBackends: async (id) => (byId.get(id)?.backends ?? []).map((backend) => ({ backend, observedAt: backend.request.timestamp, reportId: "1" })),
		loadPageTexts: async (id) => byId.get(id)?.text ? [{ name: "website.mhtml", text: byId.get(id)!.text! }] : [],
		libraryFor: async (sha256) => sha256 === JQUERY ? "gh:jquery/jquery@3.7.1/dist/jquery.min.js" : undefined,
		isPlatformHost: async () => false,
		loadPopularDomains: async () => new Set(["jsdelivr.net", "dhl.de"]),
		saveThumbnail: async () => undefined,
		...heading,
	};
}

async function store(...submissions: Submission[]) {
	for (const submission of submissions) {
		await SubmissionsEntity.create({ id: submission.id, kind: "website", data: submission.data, dedupeKey: submission.dedupeKey, status: "reported" });
	}
}

describe("campaign indicators", () => {
	test("a site builder's files link nothing and keep the site's search to its own registrable domain; the site's own and a backend's files link (production case 374590782784409610)", async () => {
		const submission = website(7n, "microsoftoutlook.builder-test.online", [
			resource("https://builder-test.org/componenti/mainPushHF.js", PLATFORM_FILE, "application/javascript", 205_929),
			resource("https://backend-test.net/gmail/js/start.js", OTHER_KIT, "application/javascript", 3_280),
			resource("https://microsoftoutlook.builder-test.online/own.js", KIT),
		]);
		const checked: string[] = [];
		const indicators = await extractIndicators(7n, {
			...fixtures({ a: { submission } }),
			isPlatformHost: async (host) => {
				checked.push(host);
				return host === "builder-test.org";
			},
		});
		// The site's own host serves only that site's files: it is never asked about.
		expect(checked.sort()).toEqual(["backend-test.net", "builder-test.org"]);
		const files = indicators.filter(({ kind }) => kind === "kit_fingerprint").map(({ value, links, evidence }) => ({ value, links, platform: evidence.platform, scope: evidence.scope }));
		expect(files).toEqual([
			{ value: PLATFORM_FILE, links: false, platform: "builder-test.org", scope: "builder-test.online" },
			{ value: KIT, links: true, platform: undefined, scope: undefined },
			{ value: OTHER_KIT, links: true, platform: undefined, scope: undefined },
		]);
	});

	test("takes backends, payment receivers, the kit's own code and the server; never libraries, CDN files, stylesheets or tiny files", async () => {
		const submission = website(1n, "phish-kit-test.com", [
			resource("https://phish-kit-test.com/assets/app.js", KIT),
			resource("https://phish-kit-test.com/js/jquery.min.js", JQUERY),
			resource("https://cdn.jsdelivr.net/npm/x/x.js", CDN_SCRIPT),
			resource("https://phish-kit-test.com/style.css", STYLE, "text/css"),
			resource("https://phish-kit-test.com/tiny.js", SMALL, "application/javascript", 300),
		]);
		const indicators = await extractIndicators(1n, fixtures({ a: { submission, backends: [botBackend("7001")], text: "Zahlung an DE89 3704 0044 0532 0130 00" } }));
		expect(indicators.map(({ kind, value, links }) => ({ kind, value, links }))).toEqual([
			{ kind: "operator_server", value: "telegram-bot:7001", links: true },
			{ kind: "payment_receiver", value: "iban:DE89370400440532013000", links: true },
			{ kind: "kit_fingerprint", value: KIT, links: true },
			{ kind: "kit_fingerprint", value: JQUERY, links: false },
			{ kind: "origin_ip", value: "203.0.113.7", links: false },
		]);
		expect(indicators.find((indicator) => indicator.value === JQUERY)?.evidence.library).toBe("gh:jquery/jquery@3.7.1/dist/jquery.min.js");
		expect(indicators[0]!.evidence).toMatchObject({ telegram: { token: "7001:AAEsecret", chatId: "-1001" }, matchedFields: ["email", "password"] });
	});

	test("takes the server that delivers a page's malware: a payload a pasted command fetched, an offered file; never a public file host or a payload never received", async () => {
		// Production: paneo.work and macmorrow.app both had visitors paste a command fetching from keychainagent.pro/wksxgj/….
		const paneo = website(1n, "paneo.work");
		paneo.data = { kind: "website", website: { ...(paneo.data.kind === "website" ? paneo.data.website : { url: "" }), investigation: { status: "completed", updatedAt: "2026-11-02T22:20:41.685Z", payloads: [
			{ url: "https://keychainagent.pro/wksxgj/wZZLR9xY29o4", sha256: "e".repeat(64), sizeBytes: 137_293, verdict: "virustotal: malicious" },
			{ url: "https://unreachable-stage.example/x", error: "fetch failed" },
			{ url: "https://raw.githubusercontent.com/someone/repo/main/stage.sh", sha256: "f".repeat(64), sizeBytes: 900 },
		] }, offeredDownload: { pageUrl: "https://paneo.work/", url: "https://paneo.work/Paneo.dmg", fileName: "Paneo.dmg", contentType: "application/x-apple-diskimage", sizeBytes: 9_000, sha256: "d".repeat(64), userAgent: "test" } } } as Submission["data"];
		const indicators = await extractIndicators(1n, { ...fixtures({ a: { submission: paneo } }), loadPopularDomains: async () => new Set(["githubusercontent.com"]) });
		expect(indicators.filter((indicator) => indicator.kind === "operator_server").map(({ value, links, evidence }) => ({ value, links, via: (evidence.delivered as { via: string }).via }))).toEqual([
			{ value: "host:keychainagent.pro", links: true, via: "pasted_command" },
			{ value: "host:raw.githubusercontent.com", links: false, via: "pasted_command" },
			{ value: "host:paneo.work", links: true, via: "offered_download" },
		]);
	});

	test("an email submission or an unknown one shows nothing", async () => {
		expect(await extractIndicators(99n, fixtures({}))).toEqual([]);
	});

	test("names a backend by the identity two sites would share", () => {
		expect(backendIndicatorValue(botBackend("123"))).toBe("telegram-bot:123");
		expect(backendIndicatorValue({ ...botBackend("123"), telegram: { token: "456:AAE" } })).toBe("telegram-bot:456");
		expect(backendIndicatorValue({ ...botBackend("1"), kind: "discord_webhook", telegram: undefined, discord: { webhookId: "999", token: "t" } })).toBe("discord-webhook:999");
		expect(backendIndicatorValue({ ...botBackend("1"), kind: "domain", telegram: undefined, hostname: "Collect.Example" })).toBe("host:collect.example");
		expect(backendIndicatorValue({ ...botBackend("1"), telegram: { token: "not-a-token" } })).toBeUndefined();
	});

	test("asks jsDelivr whether a file is a published library: 200 is one, 404 is none, anything else is an error", async () => {
		const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		expect(await lookupPublishedLibrary("a".repeat(64), answer(200, { type: "npm", name: "jquery", version: "3.7.1", file: "/dist/jquery.min.js" }))).toBe("npm:jquery@3.7.1/dist/jquery.min.js");
		expect(await lookupPublishedLibrary("a".repeat(64), answer(404, { status: 404 }))).toBeUndefined();
		await expect(lookupPublishedLibrary("a".repeat(64), answer(400, { status: 400 }))).rejects.toThrow();
	});
});

describe("campaign grouping on record", () => {
	test("sites sharing a bot or the kit's own code form one campaign; a shared library links nothing", async () => {
		const sites = {
			a: { submission: website(1n, "a-kit-test.com", [resource("https://a-kit-test.com/app.js", KIT)]), backends: [botBackend("7001")] },
			b: { submission: website(2n, "b-kit-test.com"), backends: [botBackend("7001")] },
			c: { submission: website(3n, "c-kit-test.com", [resource("https://c-kit-test.com/app.js", KIT)]) },
			d: { submission: website(4n, "d-kit-test.com", [resource("https://d-kit-test.com/jquery.js", JQUERY), resource("https://d-kit-test.com/kit.js", OTHER_KIT)]) },
			e: { submission: website(5n, "e-kit-test.com", [resource("https://e-kit-test.com/jquery.js", JQUERY)]) },
		};
		await store(...Object.values(sites).map((site) => site.submission));
		const dependencies = fixtures(sites);
		for (const id of [1n, 2n, 3n, 4n, 5n]) await linkSubmissionToCampaign(id, dependencies);

		const campaign = await CampaignRepository.campaignForSubmission(1n);
		expect(await CampaignRepository.campaignForSubmission(2n)).toBe(campaign!);
		expect(await CampaignRepository.campaignForSubmission(3n)).toBe(campaign!);
		// d has its own kit file and e only a library, so neither links to the others: each is a campaign of one.
		const solo = await CampaignRepository.campaignForSubmission(4n);
		expect(solo).toBeDefined();
		expect(solo).not.toBe(campaign!);
		const unlinked = await CampaignRepository.campaignForSubmission(5n);
		expect(unlinked).toBeDefined();
		expect([campaign, solo]).not.toContain(unlinked);
		expect((await CampaignRepository.listMembers(unlinked!)).map((member) => member.url)).toEqual(["https://e-kit-test.com/"]);

		const members = await CampaignRepository.listMembers(campaign!);
		expect(members.map((member) => member.url)).toEqual(["https://a-kit-test.com/", "https://b-kit-test.com/", "https://c-kit-test.com/"]);
		const [summary] = (await CampaignRepository.listCampaigns()).filter((entry) => entry.campaign.id === campaign);
		expect(summary).toMatchObject({ memberCount: 3, linkingIndicators: { operator_server: 1, kit_fingerprint: 1 } });
	});

	test("sites whose only link is the kit's page body, under many domains and with differing <head>s, form one campaign; another page does not join", async () => {
		// Production: 161 Vietnamese "TikTok coin" sites behind Cloudflare, with no backend, payment receiver or kit file captured, were 161 campaigns of one.
		const hosts = ["napxu.saobangmedia.shop", "napxu.trungdungmedia.sbs", "deposit-dawn-hood.trycloudflare.com", "other-kit-test.com"];
		const sites = Object.fromEntries(hosts.map((host, index) => [host, { submission: website(BigInt(index + 1), host) }]));
		await store(...Object.values(sites).map((site) => site.submission));
		for (const [index, host] of hosts.entries()) {
			const mhtml = kitCapture(host, `part-${index}`, {
				head: index === 1 ? `<link rel="canonical" href="https://${host}/">` : "",
				base64: index === 2,
				filler: host === "other-kit-test.com" ? "y".repeat(3_000) : undefined,
			});
			await ArtifactsEntity.saveBuffer({ submissionId: BigInt(index + 1), name: "website.mhtml", kind: "website_capture", mimeType: "multipart/related", buffer: mhtml });
		}
		const dependencies = fixtures(sites);
		for (const id of [1n, 2n, 3n, 4n]) await linkSubmissionToCampaign(id, dependencies);

		const campaign = await CampaignRepository.campaignForSubmission(1n);
		expect((await CampaignRepository.listMembers(campaign!)).map((member) => member.url)).toEqual(hosts.slice(0, 3).map((host) => `https://${host}/`));
		expect(await CampaignRepository.campaignForSubmission(4n)).not.toBe(campaign!);
		const [summary] = (await CampaignRepository.listCampaigns()).filter((entry) => entry.campaign.id === campaign);
		expect(summary).toMatchObject({ memberCount: 3, linkingIndicators: { kit_fingerprint: 1 } });
	});

	test("sites whose malware comes from one server form one campaign", async () => {
		const withPayload = (id: bigint, host: string, path: string) => {
			const submission = website(id, host);
			submission.data = { kind: "website", website: { url: `https://${host}/`, investigation: { status: "completed", updatedAt: "2026-11-16T13:21:06.132Z", payloads: [{ url: `https://keychainagent.pro/wksxgj/${path}`, sha256: path.repeat(64).slice(0, 64) }] } } } as Submission["data"];
			return { submission };
		};
		const sites = { paneo: withPayload(1n, "paneo.work", "a"), macmorrow: withPayload(2n, "macmorrow.app", "b"), other: { submission: website(3n, "other-kit-test.com") } };
		await store(...Object.values(sites).map((site) => site.submission));
		const dependencies = fixtures(sites);
		for (const id of [1n, 2n, 3n]) await linkSubmissionToCampaign(id, dependencies);
		const campaign = await CampaignRepository.campaignForSubmission(1n);
		expect(await CampaignRepository.campaignForSubmission(2n)).toBe(campaign!);
		expect(await CampaignRepository.campaignForSubmission(3n)).not.toBe(campaign!);
	});

	test("one server links its sites whatever it did for each: receiving one site's data, delivering another's malware; a public platform links nothing", async () => {
		const collector = (host: string): ExfiltrationBackend => ({ ...botBackend("1"), kind: "domain", key: `domain:${host}`, telegram: undefined, hostname: host, endpointUrl: `https://${host}/e` });
		const delivering = (id: bigint, host: string, payloadUrl: string) => {
			const submission = website(id, host);
			submission.data = { kind: "website", website: { url: `https://${host}/`, investigation: { status: "completed", updatedAt: "2026-11-19T14:13:04.934Z", payloads: [{ url: payloadUrl, sha256: "c".repeat(64) }] } } } as Submission["data"];
			return submission;
		};
		const sites = {
			gmail: { submission: website(1n, "impresspaper-test.com"), backends: [collector("vigilant009.example")] },
			mac: { submission: delivering(2n, "paneo-test.work", "https://vigilant009.example/stage2") },
			// Both use a public platform: the platform's host is on record but ties nobody.
			formA: { submission: website(3n, "form-a-test.com"), backends: [collector("script.google.com")] },
			formB: { submission: delivering(4n, "form-b-test.com", "https://script.google.com/macros/s/x/exec") },
		};
		await store(...Object.values(sites).map((site) => site.submission));
		const dependencies = { ...fixtures(sites), loadPopularDomains: async () => new Set(["google.com"]) };
		for (const id of [1n, 2n, 3n, 4n]) await linkSubmissionToCampaign(id, dependencies);

		const campaign = await CampaignRepository.campaignForSubmission(1n);
		expect(await CampaignRepository.campaignForSubmission(2n)).toBe(campaign!);
		const [server] = (await extractIndicators(1n, dependencies)).filter((indicator) => indicator.kind === "operator_server");
		expect(server).toMatchObject({ value: "host:vigilant009.example", links: true, evidence: { roles: ["receives_data"], endpointUrl: "https://vigilant009.example/e" } });
		expect((await extractIndicators(2n, dependencies)).find((indicator) => indicator.kind === "operator_server")).toMatchObject({ value: "host:vigilant009.example", links: true, evidence: { roles: ["delivers_malware"], delivered: { url: "https://vigilant009.example/stage2", via: "pasted_command" } } });
		expect((await extractIndicators(3n, dependencies)).find((indicator) => indicator.kind === "operator_server")).toMatchObject({ value: "host:script.google.com", links: false });
		expect(await CampaignRepository.campaignForSubmission(3n)).not.toBe(await CampaignRepository.campaignForSubmission(4n));
	});

	test("a site whose one server both receives its data and delivers its malware has one indicator naming both", async () => {
		const submission = website(1n, "both-test.com");
		submission.data = { kind: "website", website: { url: "https://both-test.com/", investigation: { status: "completed", updatedAt: "2026-11-19T14:13:04.934Z", payloads: [{ url: "https://kit-server.example/stage2", sha256: "c".repeat(64) }] } } } as Submission["data"];
		const backend: ExfiltrationBackend = { ...botBackend("1"), kind: "domain", key: "domain:kit-server.example", telegram: undefined, hostname: "kit-server.example", endpointUrl: "https://kit-server.example/collect" };
		const servers = (await extractIndicators(1n, fixtures({ a: { submission, backends: [backend] } }))).filter((indicator) => indicator.kind === "operator_server");
		expect(servers).toEqual([{ kind: "operator_server", value: "host:kit-server.example", links: true, evidence: expect.objectContaining({ roles: ["receives_data", "delivers_malware"], endpointUrl: "https://kit-server.example/collect", delivered: expect.objectContaining({ url: "https://kit-server.example/stage2" }) }) }]);
	});

	test("a site that bridges two campaigns merges them into the older; the merged id leads to the survivor", async () => {
		const sites = {
			a: { submission: website(1n, "a-kit-test.com"), backends: [botBackend("7001")] },
			b: { submission: website(2n, "b-kit-test.com"), backends: [botBackend("8002")] },
			bridge: { submission: website(3n, "bridge-kit-test.com"), backends: [botBackend("7001"), botBackend("8002")] },
		};
		await store(...Object.values(sites).map((site) => site.submission));
		const dependencies = fixtures(sites);
		await linkSubmissionToCampaign(1n, dependencies);
		await linkSubmissionToCampaign(2n, dependencies);
		const first = await CampaignRepository.campaignForSubmission(1n);
		const second = await CampaignRepository.campaignForSubmission(2n);
		expect(first).not.toBe(second!);

		await linkSubmissionToCampaign(3n, dependencies);
		const survivor = first! < second! ? first! : second!;
		const absorbed = first! < second! ? second! : first!;
		for (const id of [1n, 2n, 3n]) expect(await CampaignRepository.campaignForSubmission(id)).toBe(survivor);
		expect((await CampaignRepository.getCampaign(absorbed))?.mergedInto).toBe(survivor);
		expect(await CampaignRepository.currentCampaignId(absorbed)).toBe(survivor);
		expect((await CampaignRepository.listCampaigns()).map((entry) => entry.campaign.id)).toEqual([survivor]);
	});

	test("linking every site again gives the same grouping and keeps campaign ids", async () => {
		const sites = {
			a: { submission: website(1n, "a-kit-test.com"), backends: [botBackend("7001")] },
			b: { submission: website(2n, "b-kit-test.com"), backends: [botBackend("7001")] },
			c: { submission: website(3n, "c-kit-test.com"), text: "Pay TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
		};
		await store(...Object.values(sites).map((site) => site.submission));
		const dependencies = fixtures(sites);
		for (const id of [1n, 2n, 3n]) await linkSubmissionToCampaign(id, dependencies);
		const before = await Promise.all([1n, 2n, 3n].map((id) => CampaignRepository.campaignForSubmission(id)));

		for (const id of [3n, 1n, 2n]) await linkSubmissionToCampaign(id, dependencies);
		expect(await Promise.all([1n, 2n, 3n].map((id) => CampaignRepository.campaignForSubmission(id)))).toEqual(before);
	});

	test("a linked site keeps its page language and preview; a campaign is described again only when its sites change", async () => {
		const german = "Da die Zugänglichkeit Ihrer Seite eingeschränkt ist, bitten wir Sie, für dieses Konto höhere Sicherheitsanforderungen anzuwenden. Wir haben dieses Programm erstellt, um Ihre Seiten zu entsperren, und bitten Sie, die Daten einzugeben.";
		const sites = {
			a: { submission: website(1n, "a-kit-test.com"), backends: [botBackend("7001")], text: german },
			b: { submission: website(2n, "b-kit-test.com"), backends: [botBackend("7001")] },
			c: { submission: website(3n, "c-kit-test.com"), backends: [botBackend("7001")] },
		};
		await store(...Object.values(sites).map((site) => site.submission));
		const facts: Array<{ siteCount: number; languages: string[]; links: string[] }> = [];
		const dependencies = { ...fixtures(sites), saveThumbnail: async (id: bigint) => ({ artifactId: id * 10n, blank: id === 2n }), generate: async (input: { siteCount: number; languages: string[]; links: string[] }) => {
			facts.push({ siteCount: input.siteCount, languages: input.languages, links: input.links });
			return { title: "Fake test notice campaign", summary: "Several look-alike test pages ask for passwords and send them to one bot, so one operator runs them." };
		} };
		await linkSubmissionToCampaign(1n, dependencies);
		await linkSubmissionToCampaign(2n, dependencies);
		const campaign = (await CampaignRepository.campaignForSubmission(1n))!;
		expect(await CampaignRepository.listSiteFacts([1n, 2n])).toEqual([
			expect.objectContaining({ submissionId: 1n, language: "de", thumbnailArtifactId: 10n, blankCapture: false }),
			expect.objectContaining({ submissionId: 2n, language: null, thumbnailArtifactId: 20n, blankCapture: true }),
		]);

		expect(await describeCampaignIfChanged(campaign, dependencies)).toBe(true);
		expect(await describeCampaignIfChanged(campaign, dependencies)).toBe(false);
		await linkSubmissionToCampaign(3n, dependencies);
		expect(await describeCampaignIfChanged(campaign, dependencies)).toBe(true);
		expect(facts).toEqual([
			{ siteCount: 2, languages: ["de"], links: ["same_backend"] },
			{ siteCount: 3, languages: ["de"], links: ["same_backend"] },
		]);
		expect(await CampaignRepository.getCampaign(campaign)).toMatchObject({ title: "Fake test notice campaign", summarySiteCount: 3 });
		expect(await describeCampaignIfChanged(999n, dependencies)).toBe(false);
	});

	test("a site's preview is cut from its analyzed capture once, and whether the capture is blank is read again on every link", async () => {
		const sites = { blank: { submission: website(1n, "samtjo-test.com"), backends: [botBackend("7001")] }, page: { submission: website(2n, "page-test.com"), backends: [botBackend("7001")] } };
		await store(sites.blank.submission, sites.page.submission);
		const capture = (submissionId: bigint, buffer: Buffer) => ArtifactsEntity.saveBuffer({ submissionId, name: "website.png", kind: "website_png", mimeType: "image/png", buffer });
		const white = await sharp({ create: { width: 1905, height: 967, channels: 3, background: "#ffffff" } }).png().toBuffer();
		const card = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#2563eb" } }).png().toBuffer();
		await capture(1n, white);
		await capture(2n, await sharp(white).composite([{ input: card, left: 100, top: 100 }]).png().toBuffer());
		// The real preview step, as production runs it.
		const dependencies = { ...fixtures(sites), saveThumbnail: undefined };
		await linkSubmissionToCampaign(1n, dependencies);
		await linkSubmissionToCampaign(2n, dependencies);
		const [blank, page] = await CampaignRepository.listSiteFacts([1n, 2n]);
		expect(blank).toMatchObject({ blankCapture: true, thumbnailArtifactId: expect.any(BigInt) });
		expect(page).toMatchObject({ blankCapture: false, thumbnailArtifactId: expect.any(BigInt) });
		const previews = async (id: bigint) => (await ArtifactsEntity.listForSubmission(id)).filter((artifact) => artifact.name === "website-thumb.webp").length;
		expect(await previews(1n)).toBe(1);

		// A site linked before blank captures were recorded learns it on the next link, keeping its preview.
		await CampaignRepository.saveSiteFacts(1n, { language: null, thumbnailArtifactId: blank!.thumbnailArtifactId, blankCapture: false });
		await linkSubmissionToCampaign(1n, dependencies);
		expect((await CampaignRepository.listSiteFacts([1n]))[0]).toMatchObject({ blankCapture: true, thumbnailArtifactId: blank!.thumbnailArtifactId });
		expect(await previews(1n)).toBe(1);

		// A newer capture gets a new preview and its own reading.
		await capture(1n, await sharp(white).composite([{ input: card, left: 0, top: 0 }]).png().toBuffer());
		await linkSubmissionToCampaign(1n, dependencies);
		const [recaptured] = await CampaignRepository.listSiteFacts([1n]);
		expect(recaptured).toMatchObject({ blankCapture: false });
		expect(recaptured!.thumbnailArtifactId).not.toBe(blank!.thumbnailArtifactId);
		expect(await previews(1n)).toBe(2);
	});

	test("a site whose extraction fails keeps what is on record, and the failure surfaces", async () => {
		const sites = { a: { submission: website(1n, "a-kit-test.com"), backends: [botBackend("7001")] } };
		await store(sites.a.submission);
		await linkSubmissionToCampaign(1n, fixtures(sites));
		const campaign = await CampaignRepository.campaignForSubmission(1n);
		await expect(linkSubmissionToCampaign(1n, { ...fixtures(sites), loadBackends: async () => { throw new Error("database busy"); } })).rejects.toThrow("database busy");
		expect(await CampaignRepository.campaignForSubmission(1n)).toBe(campaign!);
	});
});

describe("a campaign's visitor guidance", () => {
	const GOOGLE = { name: "Google", officialUrl: "https://www.google.com/" };
	const assessed = (id: bigint, host: string, brand?: { name: string; officialUrl: string }): Submission => {
		const submission = website(id, host);
		const assessment: WebsiteSiteAssessment = { hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", collectionFields: [{ ref: "f1", control: "input[type=text]", placeholder: "Email or phone" }], ...(brand ? { impersonatedBrand: brand } : {}) };
		if (submission.data.kind === "website") submission.data.website.siteAssessments = [assessment];
		return submission;
	};
	const answer = {
		signInHost: "accounts.google.com",
		kinds: ["email", "password"],
		links: { recover: "https://accounts.google.com/signin/recovery", devices: null, security: "https://myaccount.google.com/security", activity: null, forwarding: "https://evil.example/fwd" },
	};

	/** Scripted model calls, recording what each was asked. */
	function scripted(guidance: () => Promise<unknown>) {
		const calls = { heading: 0, guidance: [] as GuidanceInput[] };
		const dependencies: DescribeDependencies & GuidanceDependencies = {
			generate: async () => { calls.heading += 1; return heading.generate!({} as never); },
			generateGuidance: async (input) => { calls.guidance.push(input); return guidance(); },
			reachable: async () => true,
		};
		return { calls, dependencies };
	}

	async function campaignOf(bot: string, ...submissions: Submission[]) {
		await store(...submissions);
		const sites = Object.fromEntries(submissions.map((submission) => [submission.dedupeKey, { submission, backends: [botBackend(bot)] }]));
		for (const submission of submissions) await linkSubmissionToCampaign(submission.id, fixtures(sites));
		return (await CampaignRepository.campaignForSubmission(submissions[0]!.id))!;
	}

	test("is made with the description for the brand the sites impersonate, keeping only the brand's own pages, and not again while nothing changes", async () => {
		const campaign = await campaignOf("7001", assessed(1n, "a-google-test.com", GOOGLE), assessed(2n, "b-google-test.com", GOOGLE));
		const { calls, dependencies } = scripted(async () => answer);
		expect(await describeCampaignIfChanged(campaign, dependencies)).toBe(true);
		expect(calls.heading).toBe(1);
		expect(calls.guidance).toHaveLength(1);
		expect(calls.guidance[0]).toMatchObject({ brand: { ...GOOGLE, domain: "google.com" }, facts: { siteCount: 2, impersonates: ["Google"] } });
		expect((await CampaignRepository.getCampaign(campaign))?.visitorGuidance).toEqual({
			brand: { ...GOOGLE, domain: "google.com" },
			signInHost: "accounts.google.com",
			kinds: ["email", "password"],
			links: { recover: "https://accounts.google.com/signin/recovery", security: "https://myaccount.google.com/security" },
		});
		expect(await describeCampaignIfChanged(campaign, dependencies)).toBe(false);
		expect(calls).toMatchObject({ heading: 1, guidance: [expect.anything()] });
	});

	test("a campaign described before has guidance made on the next run without a new description; a failed model call is asked again", async () => {
		const campaign = await campaignOf("7001", assessed(1n, "a-google-test.com", GOOGLE), assessed(2n, "b-google-test.com", GOOGLE));
		const failing = scripted(async () => { throw new Error("model down"); });
		expect(await describeCampaignIfChanged(campaign, failing.dependencies)).toBe(true);
		expect((await CampaignRepository.getCampaign(campaign))?.visitorGuidance).toBeNull();

		const working = scripted(async () => answer);
		expect(await describeCampaignIfChanged(campaign, working.dependencies)).toBe(true);
		expect(working.calls).toMatchObject({ heading: 0, guidance: [expect.anything()] });
		expect((await CampaignRepository.getCampaign(campaign))?.visitorGuidance?.signInHost).toBe("accounts.google.com");
		expect(await describeCampaignIfChanged(campaign, working.dependencies)).toBe(false);
	});

	test("is made anew when the sites' brand changes, and never without a brand", async () => {
		const hosts = ["a-ms-test.com", "b-ms-test.com"];
		const campaign = await campaignOf("7001", assessed(1n, hosts[0]!, GOOGLE), assessed(2n, hosts[1]!));
		const { calls, dependencies } = scripted(async () => answer);
		await describeCampaignIfChanged(campaign, dependencies);
		const microsoft = { name: "Microsoft", officialUrl: "https://www.microsoft.com/" };
		for (const [index, host] of hosts.entries()) await SubmissionsEntity.update(BigInt(index + 1), { data: assessed(BigInt(index + 1), host, microsoft).data });
		expect(await describeCampaignIfChanged(campaign, dependencies)).toBe(true);
		expect(calls.heading).toBe(1);
		expect(calls.guidance.map((input) => input.brand.name)).toEqual(["Google", "Microsoft"]);
		// The model named Google's pages for Microsoft: none lies on microsoft.com.
		expect((await CampaignRepository.getCampaign(campaign))?.visitorGuidance).toEqual({ brand: { ...microsoft, domain: "microsoft.com" }, kinds: ["email", "password"], links: {} });

		const unbranded = await campaignOf("8002", assessed(3n, "c-none-test.com"));
		const other = scripted(async () => answer);
		expect(await describeCampaignIfChanged(unbranded, other.dependencies)).toBe(true);
		expect(other.calls).toMatchObject({ heading: 1, guidance: [] });
		expect(await describeCampaignIfChanged(unbranded, other.dependencies)).toBe(false);
	});
});

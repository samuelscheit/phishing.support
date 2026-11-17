import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../db/entities";
import type { Submission } from "../db/schema";
import { useTemporaryDatabase } from "../db/test_helpers";
import type { ExfiltrationBackend } from "../exfiltration/types";
import type { WebsiteKitResource } from "../website_types";
import { backendIndicatorValue, extractIndicators, lookupPublishedLibrary } from "./indicators";
import { describeCampaignIfChanged, linkSubmissionToCampaign, rebuildCampaigns, type LinkDependencies } from "./link";
import type { DescribeDependencies } from "./summary";
import { CampaignRepository } from "./repository";

useTemporaryDatabase();

const KIT = "1".repeat(64);
const JQUERY = "2".repeat(64);
const CDN_SCRIPT = "3".repeat(64);
const STYLE = "4".repeat(64);
const SMALL = "5".repeat(64);
const OTHER_KIT = "6".repeat(64);

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
			{ kind: "exfiltration_backend", value: "telegram-bot:7001", links: true },
			{ kind: "payment_receiver", value: "iban:DE89370400440532013000", links: true },
			{ kind: "kit_fingerprint", value: KIT, links: true },
			{ kind: "kit_fingerprint", value: JQUERY, links: false },
			{ kind: "origin_ip", value: "203.0.113.7", links: false },
		]);
		expect(indicators.find((indicator) => indicator.value === JQUERY)?.evidence.library).toBe("gh:jquery/jquery@3.7.1/dist/jquery.min.js");
		expect(indicators[0]!.evidence).toMatchObject({ telegram: { token: "7001:AAEsecret", chatId: "-1001" }, matchedFields: ["email", "password"] });
	});

	test("an email submission or an unknown one shows nothing", async () => {
		expect(await extractIndicators(99n, fixtures({}))).toEqual([]);
	});

	test("names a backend by the identity two sites would share", () => {
		expect(backendIndicatorValue(botBackend("123"))).toBe("telegram-bot:123");
		expect(backendIndicatorValue({ ...botBackend("123"), telegram: { token: "456:AAE" } })).toBe("telegram-bot:456");
		expect(backendIndicatorValue({ ...botBackend("1"), kind: "discord_webhook", telegram: undefined, discord: { webhookId: "999", token: "t" } })).toBe("discord-webhook:999");
		expect(backendIndicatorValue({ ...botBackend("1"), kind: "domain", telegram: undefined, hostname: "Collect.Example" })).toBe("collector-host:collect.example");
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
		// d has its own kit file, so it is a campaign of one; e has only a library.
		const solo = await CampaignRepository.campaignForSubmission(4n);
		expect(solo).toBeDefined();
		expect(solo).not.toBe(campaign!);
		expect(await CampaignRepository.campaignForSubmission(5n)).toBeUndefined();

		const members = await CampaignRepository.listMembers(campaign!);
		expect(members.map((member) => member.url)).toEqual(["https://a-kit-test.com/", "https://b-kit-test.com/", "https://c-kit-test.com/"]);
		const [summary] = (await CampaignRepository.listCampaigns()).filter((entry) => entry.campaign.id === campaign);
		expect(summary).toMatchObject({ memberCount: 3, linkingIndicators: { exfiltration_backend: 1, kit_fingerprint: 1 } });
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

	test("a rebuild from scratch gives the same grouping and keeps campaign ids", async () => {
		const sites = {
			a: { submission: website(1n, "a-kit-test.com"), backends: [botBackend("7001")] },
			b: { submission: website(2n, "b-kit-test.com"), backends: [botBackend("7001")] },
			c: { submission: website(3n, "c-kit-test.com"), text: "Pay TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
		};
		await store(...Object.values(sites).map((site) => site.submission));
		const dependencies = fixtures(sites);
		for (const id of [1n, 2n, 3n]) await linkSubmissionToCampaign(id, dependencies);
		const before = await Promise.all([1n, 2n, 3n].map((id) => CampaignRepository.campaignForSubmission(id)));

		const result = await rebuildCampaigns(dependencies);
		// The first rebuild describes both campaigns; a second one finds nothing changed.
		expect(result).toEqual({ linked: 3, described: 2, failed: [] });
		expect((await rebuildCampaigns(dependencies)).described).toBe(0);
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
		const dependencies = { ...fixtures(sites), saveThumbnail: async (id: bigint) => id * 10n, generate: async (input: { siteCount: number; languages: string[]; links: string[] }) => {
			facts.push({ siteCount: input.siteCount, languages: input.languages, links: input.links });
			return { title: "Fake test notice campaign", summary: "Several look-alike test pages ask for passwords and send them to one bot, so one operator runs them." };
		} };
		await linkSubmissionToCampaign(1n, dependencies);
		await linkSubmissionToCampaign(2n, dependencies);
		const campaign = (await CampaignRepository.campaignForSubmission(1n))!;
		expect(await CampaignRepository.listSiteFacts([1n, 2n])).toEqual([
			expect.objectContaining({ submissionId: 1n, language: "de", thumbnailArtifactId: 10n }),
			expect.objectContaining({ submissionId: 2n, language: null, thumbnailArtifactId: 20n }),
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

	test("a site whose extraction fails keeps what is on record and is reported", async () => {
		const sites = { a: { submission: website(1n, "a-kit-test.com"), backends: [botBackend("7001")] } };
		await store(sites.a.submission);
		await linkSubmissionToCampaign(1n, fixtures(sites));
		const campaign = await CampaignRepository.campaignForSubmission(1n);
		const result = await rebuildCampaigns({ ...fixtures(sites), loadBackends: async () => { throw new Error("database busy"); } });
		expect(result.failed).toEqual([{ submissionId: "1", error: "database busy" }]);
		expect(await CampaignRepository.campaignForSubmission(1n)).toBe(campaign!);
	});
});

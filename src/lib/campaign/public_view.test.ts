import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "../db/entities/submissions";
import { useTemporaryDatabase } from "../db/test_helpers";
import type { DossierDependencies } from "../referral/dossier";
import type { WebsiteSiteAssessment } from "../website_types";
import type { ExtractedIndicator } from "./indicators";
import { getPublicCampaign } from "./public_view";
import { CampaignRepository } from "./repository";

useTemporaryDatabase();

const GOOGLE = { name: "Google", officialUrl: "https://www.google.com/" };
const bot: ExtractedIndicator = { kind: "operator_server", value: "telegram-bot:7001", links: true, evidence: { roles: ["receives_data"], backendKind: "telegram_bot", matchedFields: ["email"] } };

/** A confirmed site whose analysis found the page impersonating `brand`, with the fields it labels. */
async function site(id: bigint, host: string, assessment: Partial<WebsiteSiteAssessment> = {}, indicators: ExtractedIndicator[] = [bot]) {
	await SubmissionsEntity.create({
		id,
		kind: "website",
		data: { kind: "website", website: { url: `https://${host}/`, siteAssessments: [{ hopIndex: 0, finding: "phishing", phishingBasis: "credential_theft", ...assessment }] } },
		dedupeKey: host,
		status: "reported",
	});
	await CampaignRepository.recordIndicators(id, indicators);
	await CampaignRepository.saveSiteFacts(id, { language: null, thumbnailArtifactId: null, blankCapture: false });
	return (await CampaignRepository.campaignForSubmission(id))!;
}

const field = (placeholder: string) => ({ ref: placeholder, control: "input[type=text]", placeholder });

describe("what the public page tells a campaign's visitors", () => {
	test("without guidance: the brand with its domain and no links, and what the pages ask for in page order", async () => {
		const campaign = await site(1n, "samtjo-test.com", { impersonatedBrand: GOOGLE, collectionFields: [field("Mật khẩu"), field("Email or phone")] });
		await site(2n, "other-test.com", { impersonatedBrand: GOOGLE, collectionFields: [field("Enter code")] });
		await CampaignRepository.saveSiteFacts(1n, { language: null, thumbnailArtifactId: 7n, blankCapture: true });
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

	test("counts a site as confirmed and as reported exactly as its takedown says", async () => {
		const campaign = await site(1n, "a-test.com");
		await site(2n, "b-test.com");
		await site(3n, "c-test.com");
		const statuses: Record<string, string[]> = { "1": ["acknowledged", "delivery_failed"], "2": ["awaiting_provider_reply"], "3": ["provider_rejected"] };
		const dependencies: DossierDependencies = {
			listReports: (async (submissionId: bigint) => [{ id: submissionId, legalBrandUrl: null, idempotencyKey: null, description: null }]) as never,
			listRoutes: (async (reportId: bigint) => statuses[reportId.toString()]!.map((status, index) => ({
				id: BigInt(index + 1), targetId: 1n, providerRegistryKey: `email:host${index}.example`, providerDisplayName: `Host ${index}`, routeType: "email", verifiedEmail: `abuse@host${index}.example`, status, resolverProvenance: {}, resolutionSnapshot: {},
			}))) as never,
			listTargets: (async () => []) as never,
			listRuns: (async () => []) as never,
			listMail: (async () => []) as never,
			listReportArtifacts: (async () => []) as never,
		};
		const view = (await getPublicCampaign(campaign, dependencies))!;
		expect(view.sites.map((entry) => entry.takedown)).toEqual(["confirmed", "reported", "problem"]);
		expect(view).toMatchObject({ confirmedCount: 1, reportedCount: 2 });
	});
});

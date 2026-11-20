import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { getDb } from "../../../db";
import { useTemporaryDatabase } from "../../../db/test_helpers";
import { abuseProviderRoutes, abuseTargets } from "../../schema";
import { storedAwsSubmissionPayload } from "../aws/payload";
import { prepareAwsSubmission, verifiedAwsDraft } from "../aws/submission";
import { storedMicrosoftSubmissionPayload } from "../microsoft/payload";
import { prepareMicrosoftSubmission, verifiedMicrosoftDraft } from "../microsoft/submission";
import { storedNameSiloSubmissionPayload } from "../namesilo/payload";
import { prepareNameSiloSubmission, verifiedNameSiloDraft } from "../namesilo/submission";
import { storedTencentSubmissionPayload } from "../tencent/payload";
import { prepareTencentSubmission, verifiedTencentDraft } from "../tencent/submission";
import { storedDynadotSubmissionPayload } from "../dynadot/payload";
import { prepareDynadotSubmission, verifiedDynadotDraft } from "../dynadot/submission";
import { storedGoDaddySubmissionPayload } from "../godaddy/payload";
import { prepareGoDaddySubmission, verifiedGoDaddyDraft } from "../godaddy/submission";
import { storedNameComSubmissionPayload } from "../name_com/payload";
import { prepareNameComSubmission, verifiedNameComDraft } from "../name_com/submission";
import { storedNewfoldSubmissionPayload } from "../newfold/payload";
import { prepareNewfoldSubmission, verifiedNewfoldDraft } from "../newfold/submission";
import { storedTucowsSubmissionPayload } from "../tucows/payload";
import { prepareTucowsSubmission, verifiedTucowsDraft } from "../tucows/submission";
import { storedPublicDomainRegistrySubmissionPayload } from "../publicdomainregistry/payload";
import { preparePublicDomainRegistrySubmission, verifiedPublicDomainRegistryDraft } from "../publicdomainregistry/submission";
import type { ProviderSubmissionContext, ProviderSubmissionPreparation } from "../submission_contracts";
import { PNG, readyDraft, routeFixture, type RouteFixtureOptions } from "./testing";

useTemporaryDatabase();

// Providers that pay a captcha solver refuse to draft without its credentials.
process.env.DEATHBYCAPTCHA_USERNAME ??= "test-user";
process.env.DEATHBYCAPTCHA_PASSWORD ??= "test-password";
process.env.PROXY_URL ??= "socks5://proxy.example:1080";

type Row = {
	key: string;
	route: RouteFixtureOptions;
	prepare: (context: ProviderSubmissionContext) => Promise<ProviderSubmissionPreparation>;
	verify: (context: ProviderSubmissionContext) => Promise<{ payload: unknown }>;
	read: (value: unknown) => unknown;
	reasonPrefix: string;
	/** The reason for a target that is not a domain. */
	targetReason: string;
	/** A target type the provider refuses (default `ip`). */
	refusedTargetType?: "email";
	/** A well-formed draft whose free text no longer is what the builder writes. */
	tamper: (payload: any) => unknown;
};

/**
 * The draft contract every direct provider shares: a ready draft rebuilds
 * exactly, and a draft of another pin, route, target or content is refused.
 */
const ROWS: Row[] = [
	{
		key: "name_com",
		route: { mailbox: "abuse@name.com", providerName: "Name.com", screenshot: PNG },
		prepare: prepareNameComSubmission,
		verify: (context) => verifiedNameComDraft(context),
		read: storedNameComSubmissionPayload,
		reasonPrefix: "name_com",
		targetReason: "name_com_requires_a_domain_target",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, additional: `${payload.report.additional}\n\nAlso, please wire money.` } }),
	},
	{
		key: "dynadot",
		route: { mailbox: "abuse@dynadot.com", providerName: "Dynadot", screenshot: PNG },
		prepare: prepareDynadotSubmission,
		verify: (context) => verifiedDynadotDraft(context),
		read: storedDynadotSubmissionPayload,
		reasonPrefix: "dynadot",
		targetReason: "dynadot_requires_a_domain_target",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, comments: `${payload.report.comments}\n\nAlso, please wire money.` } }),
	},
	{
		key: "newfold",
		route: { mailbox: "abuse@bluehost.com", providerName: "Newfold", screenshot: PNG },
		prepare: prepareNewfoldSubmission,
		verify: (context) => verifiedNewfoldDraft(context),
		read: storedNewfoldSubmissionPayload,
		reasonPrefix: "newfold",
		targetReason: "newfold_requires_a_domain_target",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, brand: "150-hostgator" } }),
	},
	{
		key: "publicdomainregistry",
		route: { mailbox: "abuse@publicdomainregistry.com", providerName: "PDR", screenshot: PNG },
		prepare: preparePublicDomainRegistrySubmission,
		verify: (context) => verifiedPublicDomainRegistryDraft(context),
		read: storedPublicDomainRegistrySubmissionPayload,
		reasonPrefix: "publicdomainregistry",
		targetReason: "publicdomainregistry_requires_a_domain_target",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, complaint: `${payload.report.complaint}\n\nAlso, please wire money.` } }),
	},
	{
		key: "godaddy",
		route: { mailbox: "abuse@godaddy.com", providerName: "GoDaddy" },
		prepare: prepareGoDaddySubmission,
		verify: (context) => verifiedGoDaddyDraft(context),
		read: storedGoDaddySubmissionPayload,
		reasonPrefix: "godaddy",
		targetReason: "godaddy_requires_a_domain_target",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, info: `${payload.report.info}\n\nAlso, please wire money.` } }),
	},
	{
		key: "tucows_bullwark",
		route: { mailbox: "domainabuse@tucows.com", providerName: "Tucows", screenshot: PNG },
		prepare: prepareTucowsSubmission,
		verify: (context) => verifiedTucowsDraft(context),
		read: storedTucowsSubmissionPayload,
		reasonPrefix: "tucows",
		targetReason: "tucows_requires_a_domain_target",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, description: `${payload.report.description} edited` } }),
	},
	{
		key: "namesilo",
		route: { mailbox: "abuse@namesilo.com", providerName: "NameSilo", screenshot: PNG },
		prepare: (context) => prepareNameSiloSubmission(context),
		verify: async (context) => ({ payload: (await verifiedNameSiloDraft(context)).payload }),
		read: storedNameSiloSubmissionPayload,
		reasonPrefix: "namesilo",
		targetReason: "namesilo_requires_a_domain_target",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, explanation: `${payload.report.explanation} edited` } }),
	},
	{
		key: "tencent",
		route: { mailbox: "dnsabuse_complaint@tencent.com", providerName: "Tencent", screenshot: PNG },
		prepare: (context) => prepareTencentSubmission(context),
		verify: async (context) => ({ payload: (await verifiedTencentDraft(context)).payload }),
		read: storedTencentSubmissionPayload,
		reasonPrefix: "tencent",
		targetReason: "tencent_requires_a_domain_target",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, explanation: `${payload.report.explanation} edited` } }),
	},
	{
		key: "aws_trust_safety",
		route: { mailbox: "trustandsafety@support.aws.com", providerName: "AWS" },
		prepare: prepareAwsSubmission,
		verify: async (context) => ({ payload: await verifiedAwsDraft(context) }),
		read: storedAwsSubmissionPayload,
		reasonPrefix: "aws",
		targetReason: "aws_requires_a_web_target",
		refusedTargetType: "email",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, comments: `${payload.report.comments} edited` } }),
	},
	{
		key: "microsoft_msrc",
		route: { mailbox: "abuse@microsoft.com", providerName: "Microsoft" },
		prepare: prepareMicrosoftSubmission,
		verify: async (context) => ({ payload: await verifiedMicrosoftDraft(context) }),
		read: storedMicrosoftSubmissionPayload,
		reasonPrefix: "microsoft",
		targetReason: "microsoft_requires_a_web_target",
		refusedTargetType: "email",
		tamper: (payload) => ({ ...payload, report: { ...payload.report, notes: `${payload.report.notes} edited` } }),
	},
];

for (const row of ROWS) {
	describe(`${row.key} draft contract`, () => {
		test("a ready draft is read back and rebuilds to itself", async () => {
			const { payload, context } = await readyDraft(row.route, row.prepare, row.read);
			expect((await row.verify(context)).payload).toEqual(payload);
		});

		test("a pin mismatch, a foreign route and a non-domain target end as insufficient evidence", async () => {
			const db = await getDb();
			const mismatch = await routeFixture(row.route);
			db.update(abuseProviderRoutes).set({ providerDefinitionHash: "0".repeat(64) }).where(eq(abuseProviderRoutes.id, mismatch.route.id)).run();
			expect(await row.prepare({ routeId: mismatch.route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: `${row.reasonPrefix}_provider_definition_pin_mismatch` });
			const foreign = await routeFixture(row.route);
			db.update(abuseProviderRoutes).set({ providerRegistryKey: "other" }).where(eq(abuseProviderRoutes.id, foreign.route.id)).run();
			expect(await row.prepare({ routeId: foreign.route.id, payload: {} })).toMatchObject({ reason: `${row.reasonPrefix}_provider_definition_pin_mismatch` });
			const ip = await routeFixture(row.route);
			db.update(abuseTargets).set({ targetType: row.refusedTargetType ?? "ip" }).where(eq(abuseTargets.id, ip.targetId)).run();
			expect(await row.prepare({ routeId: ip.route.id, payload: {} })).toEqual({ outcome: "insufficient_evidence", reason: row.targetReason });
		});

		test("a malformed, drifted or foreign draft is refused before anything crosses the provider boundary", async () => {
			const { context, route } = await readyDraft(row.route, row.prepare, row.read);
			await expect(row.verify({ ...context, payload: { ...context.payload, adapter: "x" } })).rejects.toThrow("malformed");
			await expect(row.verify({ ...context, payload: row.tamper(context.payload) as Record<string, unknown> })).rejects.toThrow("no longer matches the report");
			(await getDb()).update(abuseProviderRoutes).set({ providerRegistryKey: "other" }).where(eq(abuseProviderRoutes.id, route.id)).run();
			await expect(row.verify(context)).rejects.toThrow("no longer matches its route");
		});
	});
}

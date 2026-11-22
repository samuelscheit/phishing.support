import { describe, expect, test } from "bun:test";
// The registry first: imported from a provider module, the abuse package's import cycle reaches the registry before that provider is initialised.
import "./submission_registry_default";
import { and, eq } from "drizzle-orm";

import { getDb } from "../../db";
import { useTemporaryDatabase } from "../../db/test_helpers";
import { AbuseRepository } from "../repository";
import { abuseEvents, abuseJobs } from "../schema";
import { cloudflareProvider } from "./cloudflare";
import { CLOUDFLARE_PROVIDER } from "./cloudflare/definition";
import { cloudflareDraft, prepareCloudflareExternalSubmission, submitCloudflareSubmission } from "./cloudflare/submission";
import { defineProvider } from "./kit/provider";
import { routeFixture } from "./kit/testing";
import { netcraftProvider } from "./netcraft";
import { NETCRAFT_PROVIDER } from "./netcraft/definition";
import { netcraftDraft, submitNetcraftSubmission } from "./netcraft/submission";
import { resettleDuplicateRejections } from "./resettle_duplicate_rejections";
import { executeProviderSubmission } from "./submission_execution";
import type { FetchLike } from "../../http/fetch";

useTemporaryDatabase();

const ACCOUNT_ID = "b9077acfb4ef45e0f94b0f52c06c289a";
const environment = { ABUSE_CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, ABUSE_CLOUDFLARE_LOGIN_EMAIL: "operator@example.com", ABUSE_CLOUDFLARE_LOGIN_PASSWORD: "test-password" };
const session = { id: "atok", atok: "atok", vses2: "cookie", expiresAt: Date.now() + 86_400_000 };
const TARGET = "login-example-phish.com";
const URL_A = `https://${TARGET}/signin`;
const URL_B = `https://${TARGET}/other`;
const SUBMITTED = `https://dash.cloudflare.com/${ACCOUNT_ID}/abuse-reports/submitted`;
const NETCRAFT_DUPLICATE_BODY = '{"details":[{"message":"Duplicate of a recent submission"}],"error":"Bad Request","status":400}';

const noListing: FetchLike = async () => Response.json({ success: true, result: { reports: [] } });

/** The production Cloudflare provider, answering POSTs with `post` and reads with an empty account listing. */
function cloudflareWith(post: () => Response) {
	const deps = { environment, getSession: async () => session, fetch: (async (url, init) => init?.method === "POST" ? post() : noListing(url, init)) as FetchLike };
	return defineProvider({
		definition: CLOUDFLARE_PROVIDER,
		draft: { prepare: (context) => cloudflareDraft.prepare(context, deps), verify: (context) => cloudflareDraft.verify(context, deps) },
		external: { prepare: (context, verified) => prepareCloudflareExternalSubmission(context, verified, deps), submit: (context, preflight) => submitCloudflareSubmission(context, preflight, deps) },
		...(cloudflareProvider.reportedUrls ? { reportedUrls: cloudflareProvider.reportedUrls } : {}),
		fetchCorrespondence: async () => ({ messages: [] }),
	});
}

function netcraftWith(post: () => Response) {
	return defineProvider({
		definition: NETCRAFT_PROVIDER,
		draft: netcraftDraft,
		submit: (context) => submitNetcraftSubmission(context, { fetch: async () => post() }),
		...(netcraftProvider.reportedUrls ? { reportedUrls: netcraftProvider.reportedUrls } : {}),
		fetchCorrespondence: async () => ({ messages: [] }),
	});
}

const cloudflareFixture = (observedUrls = [URL_A]) => routeFixture({ mailbox: "abuse@cloudflare.com", providerName: "Cloudflare", observedUrls });
const netcraftFixture = (observedUrls = [URL_A]) => routeFixture({ mailbox: { supplemental: NETCRAFT_PROVIDER.key }, providerName: "Netcraft", observedUrls });
const cloudflareAccepted = (id: string) => () => Response.json({ result: "success", abuse_rand: id });
const cloudflareDuplicate = (url = URL_A) => () => Response.json({ result: "error", msg: `You have already submitted this URL recently: ${url}` }, { status: 400 });
const netcraftAccepted = (uuid: string) => () => Response.json({ message: "Successfully reported", uuid });
const netcraftDuplicate = () => new Response(NETCRAFT_DUPLICATE_BODY, { status: 400 });

async function latestRun(routeId: bigint) {
	return (await AbuseRepository.getLatestProviderRunForRoute(routeId))!;
}

async function pollJobs(routeId: bigint) {
	const db = await getDb();
	return db.select().from(abuseJobs).where(and(eq(abuseJobs.routeId, routeId), eq(abuseJobs.jobType, "poll_provider_correspondence"))).all();
}

describe("a duplicate answer settles the route as reported", () => {
	test("Cloudflare adopts the receipt of our earlier route that reported the same URL, and polls it", async () => {
		const first = await cloudflareFixture();
		expect(await executeProviderSubmission({ routeId: first.route.id, provider: cloudflareWith(cloudflareAccepted("aaaaaaaaaaaaaaa1")) })).toMatchObject({ outcome: "submitted" });
		// Another URL's report of the same provider is not the receipt.
		const other = await cloudflareFixture([URL_B]);
		await executeProviderSubmission({ routeId: other.route.id, provider: cloudflareWith(cloudflareAccepted("bbbbbbbbbbbbbbb2")) });

		const second = await cloudflareFixture();
		expect(await executeProviderSubmission({ routeId: second.route.id, provider: cloudflareWith(cloudflareDuplicate()) })).toMatchObject({ outcome: "submitted" });
		expect((await AbuseRepository.getRoute(second.route.id))?.status).toBe("submitted");
		expect(await latestRun(second.route.id)).toMatchObject({
			executionStatus: "completed",
			confirmationId: "aaaaaaaaaaaaaaa1",
			confirmationText: `Cloudflare already had a recent report for ${URL_A}. Its earlier report aaaaaaaaaaaaaaa1 is this route's receipt.`,
			finalUrl: SUBMITTED,
			submittedTargets: [TARGET],
			failureReason: null,
		});
		expect(await pollJobs(second.route.id)).toHaveLength(1);
	});

	test("without an earlier receipt it is still submitted, with a clear text and nothing to poll", async () => {
		const { route } = await cloudflareFixture([`https://${TARGET}/never-reported`]);
		expect(await executeProviderSubmission({ routeId: route.id, provider: cloudflareWith(cloudflareDuplicate(`https://${TARGET}/never-reported`)) })).toMatchObject({ outcome: "submitted" });
		expect(await latestRun(route.id)).toMatchObject({
			executionStatus: "completed",
			confirmationId: null,
			confirmationText: `Cloudflare already had a recent report for https://${TARGET}/never-reported.`,
			finalUrl: SUBMITTED,
			submittedTargets: [TARGET],
		});
		expect(await pollJobs(route.id)).toHaveLength(0);
	});

	test("any other 4xx stays a rejection", async () => {
		const { route } = await cloudflareFixture();
		const answer = () => Response.json({ result: "error", msg: "You have already submitted this URL recently" }, { status: 400 });
		expect(await executeProviderSubmission({ routeId: route.id, provider: cloudflareWith(answer) })).toMatchObject({ outcome: "provider_rejected" });
	});

	test("Netcraft adopts an earlier run that reported every duplicated URL, never one that reported only some", async () => {
		const partial = await netcraftFixture([URL_A]);
		await executeProviderSubmission({ routeId: partial.route.id, provider: netcraftWith(netcraftAccepted("cccccccccccccccccccccccccccccccc")) });
		const both = await netcraftFixture([URL_A, URL_B]);
		const duplicate = await netcraftFixture([URL_A, URL_B]);
		await executeProviderSubmission({ routeId: duplicate.route.id, provider: netcraftWith(netcraftDuplicate) });
		expect(await latestRun(duplicate.route.id)).toMatchObject({ confirmationId: null, confirmationText: `Netcraft already had a recent submission for ${URL_A}, ${URL_B}.` });

		await executeProviderSubmission({ routeId: both.route.id, provider: netcraftWith(netcraftAccepted("dddddddddddddddddddddddddddddddd")) });
		const later = await netcraftFixture([URL_A]);
		await executeProviderSubmission({ routeId: later.route.id, provider: netcraftWith(netcraftDuplicate) });
		// The newest run naming the URL wins; its receipt keeps Netcraft's status reads working.
		expect(await latestRun(later.route.id)).toMatchObject({
			executionStatus: "completed",
			confirmationId: "dddddddddddddddddddddddddddddddd",
			finalUrl: "https://report.netcraft.com/api/v3/submission/dddddddddddddddddddddddddddddddd",
			submittedTargets: [TARGET],
		});
		expect(await pollJobs(later.route.id)).toHaveLength(1);
	});
});

describe("resettling routes rejected for a duplicate answer", () => {
	async function rejected(fixture: Awaited<ReturnType<typeof routeFixture>>, provider: ReturnType<typeof defineProvider>, failureReason: string) {
		const prepared = await provider.prepareSubmission({ routeId: fixture.route.id, payload: {} });
		if (prepared.outcome !== "ready") throw new Error("Expected a ready draft.");
		const run = await AbuseRepository.createProviderRun({ routeId: fixture.route.id, providerPayload: prepared.payload });
		expect(await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "failed", routeStatus: "provider_rejected", failureReason, routeData: { reason: failureReason } })).toBeTrue();
		return { routeId: fixture.route.id, reportId: fixture.created.reportId, runId: run.id };
	}

	test("settles exactly the production duplicate rejections as submitted, once", async () => {
		const cloudflare = cloudflareWith(cloudflareAccepted("eeeeeeeeeeeeeee5"));
		const earlier = await cloudflareFixture();
		await executeProviderSubmission({ routeId: earlier.route.id, provider: cloudflare });

		const adopted = await rejected(await cloudflareFixture(), cloudflare, `Cloudflare abuse report was rejected with HTTP 400: You have already submitted this URL recently: ${URL_A}`);
		const unadopted = await rejected(await cloudflareFixture([URL_B]), cloudflare, `Cloudflare abuse report was rejected with HTTP 400: You have already submitted this URL recently: ${URL_B}`);
		const netcraft = await rejected(await netcraftFixture(), netcraftWith(netcraftDuplicate), `Netcraft report was rejected with HTTP 400: ${NETCRAFT_DUPLICATE_BODY}`);
		const untouched = await Promise.all([
			rejected(await cloudflareFixture(), cloudflare, "Cloudflare abuse report was rejected with HTTP 400: bad justification"),
			rejected(await cloudflareFixture(), cloudflare, `Cloudflare abuse report was rejected with HTTP 429: You have already submitted this URL recently: ${URL_A}`),
			rejected(await cloudflareFixture(), cloudflare, `Cloudflare abuse report was rejected with HTTP 400: You have already submitted this URL recently: ${URL_A} and more`),
			rejected(await netcraftFixture(), netcraftWith(netcraftDuplicate), 'Netcraft report was rejected with HTTP 400: {"details":[{"message":"Duplicate of a recent submission"},{"message":"Invalid URL"}]}'),
			rejected(await netcraftFixture(), netcraftWith(netcraftDuplicate), `Netcraft report was rejected with HTTP 409: ${NETCRAFT_DUPLICATE_BODY}`),
		]);

		const result = await resettleDuplicateRejections(environment);
		expect(result).toEqual([
			{ routeId: adopted.routeId, providerRegistryKey: CLOUDFLARE_PROVIDER.key, confirmationId: "eeeeeeeeeeeeeee5" },
			{ routeId: unadopted.routeId, providerRegistryKey: CLOUDFLARE_PROVIDER.key },
			{ routeId: netcraft.routeId, providerRegistryKey: NETCRAFT_PROVIDER.key },
		].sort((a, b) => (a.routeId < b.routeId ? -1 : 1)));
		expect(await latestRun(adopted.routeId)).toMatchObject({ executionStatus: "completed", confirmationId: "eeeeeeeeeeeeeee5", failureReason: null, submittedTargets: [TARGET] });
		expect(await latestRun(unadopted.routeId)).toMatchObject({ executionStatus: "completed", confirmationId: null, confirmationText: `Cloudflare already had a recent report for ${URL_B}.` });
		expect(await latestRun(netcraft.routeId)).toMatchObject({ executionStatus: "completed", confirmationText: `Netcraft already had a recent submission for ${URL_A}.` });
		for (const { routeId } of [adopted, unadopted, netcraft]) expect((await AbuseRepository.getRoute(routeId))?.status).toBe("submitted");
		expect((await AbuseRepository.getReport(adopted.reportId))?.status).toBe("submitted");
		for (const { routeId, runId } of untouched) {
			expect((await AbuseRepository.getRoute(routeId))?.status).toBe("provider_rejected");
			expect((await latestRun(routeId)).id).toBe(runId);
		}
		expect(await pollJobs(adopted.routeId)).toHaveLength(1);
		expect(await pollJobs(unadopted.routeId)).toHaveLength(0);
		const db = await getDb();
		const events = db.select().from(abuseEvents).where(and(eq(abuseEvents.routeId, adopted.routeId), eq(abuseEvents.eventType, "provider_run.reconciled"))).all();
		expect(events.map((event) => event.data)).toEqual([expect.objectContaining({ to: "submitted", confirmationId: "eeeeeeeeeeeeeee5", reconciliationReason: "provider_duplicate_answer" })]);

		// Idempotent: a second run finds nothing left to change.
		expect(await resettleDuplicateRejections(environment)).toEqual([]);
	});

	test("a run stored before drafts carried their pin (the production shape) is recognised by its target", async () => {
		const fixture = await cloudflareFixture();
		const legacy = { adapter: "cloudflare_abuse_api_v1", providerNarrativeVersion: 1, target: TARGET, report: { name: "Phishing Support", email: "support@phishing.support", company: "Phishing Support", urls: URL_A, justification: "x", reportedCountry: "DE" } };
		const run = await AbuseRepository.createProviderRun({ routeId: fixture.route.id, providerPayload: legacy });
		const reason = `Cloudflare abuse report was rejected with HTTP 400: You have already submitted this URL recently: ${URL_A}`;
		await AbuseRepository.settleProviderRun({ runId: run.id, executionStatus: "failed", routeStatus: "provider_rejected", failureReason: reason, routeData: { reason } });
		// A pinless payload of another adapter, or without a target, stays untouched.
		const other = await cloudflareFixture();
		const otherRun = await AbuseRepository.createProviderRun({ routeId: other.route.id, providerPayload: { ...legacy, target: 7 } });
		await AbuseRepository.settleProviderRun({ runId: otherRun.id, executionStatus: "failed", routeStatus: "provider_rejected", failureReason: reason, routeData: { reason } });

		expect(await resettleDuplicateRejections(environment)).toEqual([{ routeId: fixture.route.id, providerRegistryKey: CLOUDFLARE_PROVIDER.key }]);
		expect(await latestRun(fixture.route.id)).toMatchObject({ executionStatus: "completed", confirmationText: `Cloudflare already had a recent report for ${URL_A}.`, submittedTargets: [TARGET] });
		expect((await AbuseRepository.getRoute(other.route.id))?.status).toBe("provider_rejected");
		expect(await resettleDuplicateRejections(environment)).toEqual([]);
	});

	test("only the route's latest run counts", async () => {
		const fixture = await cloudflareFixture();
		const cloudflare = cloudflareWith(cloudflareAccepted("fffffffffffffff6"));
		const { routeId } = await rejected(fixture, cloudflare, `Cloudflare abuse report was rejected with HTTP 400: You have already submitted this URL recently: ${URL_A}`);
		await AbuseRepository.createProviderRun({ routeId, providerPayload: { later: true } });
		expect(await resettleDuplicateRejections(environment)).toEqual([]);
		expect((await AbuseRepository.getRoute(routeId))?.status).toBe("provider_rejected");
	});
});

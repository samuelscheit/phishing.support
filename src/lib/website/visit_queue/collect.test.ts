import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { createAbuseEmailDraft } from "@/lib/abuse/mail/draft";
import { claimNextJob } from "@/lib/abuse/persistence/jobs";
import { listGroupHostUrls, websiteReportSubject } from "@/lib/abuse/persistence/reports";
import { AbuseRepository } from "@/lib/abuse/repository";
import { isRegistrarRoute } from "@/lib/abuse/resolver/contact_chain";
import { abuseReportCases, jobs } from "@/lib/abuse/schema";
import { validateAbuseReportRequest } from "@/lib/abuse/contracts";
import { reportCaseSite } from "@/lib/campaign/test_sites";
import { getDb } from "@/lib/db";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import type { ContentVerification } from "@/lib/liveness/content";
import { siteChecks } from "@/lib/liveness/schema";
import { createWebsiteSubmission, retryWebsiteAnalysis } from "@/lib/submissions/website";
import { collectSiblingsOf, collectSiteGroup, probeCollectedHost, SIBLING_TRIAL_LIMIT } from "./collect";
import { queuedVisits, runQueuedVisits } from "./test_helpers";

useTemporaryDatabase();

const REPORTER = { reporterIp: "5.189.203.86" };

/** A host of a group visited and reported, the way the analysis leaves it: its case reported, its site's report filed. */
async function reported(url: string) {
	const { id } = await createWebsiteSubmission({ url, ...REPORTER });
	await (await getDb()).delete(jobs).where(eq(jobs.dedupeKey, `website-visit:${id}`)).run();
	await SubmissionsEntity.update(id, { status: "reported" });
	const { reportId } = await reportCaseSite(id, url);
	return { id, reportId };
}

const caseOf = async (id: bigint) => (await SubmissionsEntity.get(id))!;
const joinedCases = async (reportId: bigint) => (await getDb()).select({ submissionId: abuseReportCases.submissionId }).from(abuseReportCases).where(eq(abuseReportCases.reportId, reportId)).all().map((row) => row.submissionId);
const jobsOf = async (type: "probe_collected_host" | "link_campaign") => (await getDb()).select().from(jobs).where(eq(jobs.jobType, type)).all();

describe("a host of a reported domain", () => {
	test("is collected into the domain's report when it is submitted: never queued, never visited", async () => {
		const anchor = await reported("https://a.slon10.to/login");
		const sibling = await createWebsiteSubmission({ url: "https://b.c.slon10.to/x", ...REPORTER });

		expect(sibling.status).toBe("collected");
		const stored = await caseOf(sibling.id);
		expect(stored.info).toBe("Not visited: slon10.to is already reported; this host was added to that report.");
		expect(stored.data.kind === "website" && stored.data.website.collected).toMatchObject({ reason: "sibling_reported", siteGroup: "slon10.to", reportId: anchor.reportId.toString(), intoSubmissionId: anchor.id.toString() });
		expect(await queuedVisits()).toEqual([]);
		expect(await joinedCases(anchor.reportId)).toEqual([sibling.id]);
		expect((await jobsOf("probe_collected_host")).map((job) => job.payload)).toEqual([{ submissionId: sibling.id.toString() }]);
		expect((await jobsOf("link_campaign")).map((job) => [job.payload?.submissionId, job.reportId])).toContainEqual([sibling.id.toString(), anchor.reportId]);
		const [joined] = (await AbuseRepository.listEvents(anchor.reportId)).filter((event) => event.eventType === "report.case_joined");
		expect(joined!.data).toEqual({ submissionId: sibling.id.toString(), urls: ["https://b.c.slon10.to/x"], collected: true });
		// The registrar is told of the host; the reported host itself is not repeated.
		expect(await listGroupHostUrls(anchor.reportId)).toEqual(["https://b.c.slon10.to/x"]);
	});

	test("a platform tenant, a re-report and an address are visited whatever their neighbours", async () => {
		await reported("https://kit.pages.dev/");
		await reported("http://85.215.226.225/a");
		const tenant = await createWebsiteSubmission({ url: "https://other.pages.dev/", ...REPORTER });
		const sameTenant = await createWebsiteSubmission({ url: "https://preview.kit.pages.dev/", ...REPORTER });
		const address = await createWebsiteSubmission({ url: "http://85.215.226.225/b", ...REPORTER });
		const anchor = await reported("https://a.slon10.to/");
		const rereport = await createWebsiteSubmission({ url: "https://a.slon10.to/", rereport: true, ...REPORTER });
		expect([tenant.status, sameTenant.status, address.id === (await caseOf(address.id)).id && address.status, rereport.status]).toEqual(["queued", "queued", "reported", "queued"]);
		expect(await joinedCases(anchor.reportId)).toEqual([]);
	});

	test("a report older than the window is no reason not to visit; one taken down is", async () => {
		const anchor = await reported("https://a.old-kit-test.com/");
		(await getDb()).update((await import("@/lib/abuse/schema")).abuseReports).set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60_000) }).run();
		expect((await createWebsiteSubmission({ url: "https://b.old-kit-test.com/", ...REPORTER })).status).toBe("queued");
		const [target] = await AbuseRepository.listTargets(anchor.reportId);
		(await getDb()).insert(siteChecks).values({ id: 1n, reportId: anchor.reportId, targetId: target!.id, url: "https://a.old-kit-test.com/", state: "domain_suspended", checkedAt: new Date() }).run();
		expect((await createWebsiteSubmission({ url: "https://c.old-kit-test.com/", ...REPORTER })).status).toBe("collected");
	});

	test("waiting hosts are collected once a host of their domain is reported; hosts being visited or settled are left", async () => {
		const queued = await createWebsiteSubmission({ url: "https://q.slon10.to/", ...REPORTER });
		const visiting = await createWebsiteSubmission({ url: "https://v.slon10.to/", ...REPORTER });
		const failedRetrying = await createWebsiteSubmission({ url: "https://f.slon10.to/", ...REPORTER });
		const failedForGood = await createWebsiteSubmission({ url: "https://g.slon10.to/", ...REPORTER });
		const invalid = await createWebsiteSubmission({ url: "https://i.slon10.to/", ...REPORTER });
		const elsewhere = await createWebsiteSubmission({ url: "https://other.example/", ...REPORTER });
		// The queue visits the first host of the group; the others wait behind it.
		const job = (await claimNextJob("worker", 60_000, { jobTypes: ["visit_website"] }))!;
		expect(job.payload?.submissionId).toBe(queued.id.toString());
		await SubmissionsEntity.update(failedRetrying.id, { status: "failed", data: { kind: "website", website: { url: "https://f.slon10.to/", autoRetry: { attempts: 1, nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), reason: "relay" } } } });
		await SubmissionsEntity.update(failedForGood.id, { status: "failed" });
		await SubmissionsEntity.update(invalid.id, { status: "invalid" });
		// v.slon10.to is visited and reported meanwhile (as if the group's serial key had let it through first).
		await SubmissionsEntity.update(visiting.id, { status: "reported" });
		const { reportId } = await reportCaseSite(visiting.id, "https://v.slon10.to/");

		expect(await collectSiblingsOf(visiting.id)).toBe(1);
		expect((await caseOf(failedRetrying.id)).status).toBe("collected");
		// The host being visited finishes its visit; settled hosts keep their verdicts.
		expect([(await caseOf(queued.id)).status, (await caseOf(failedForGood.id)).status, (await caseOf(invalid.id)).status, (await caseOf(elsewhere.id)).status]).toEqual(["queued", "failed", "invalid", "queued"]);
		expect(await joinedCases(reportId)).toEqual([failedRetrying.id]);
		// The clean-up of an old flood takes the settled hosts too, never the one being visited or the reported one.
		expect(await collectSiteGroup("slon10.to", { includeSettled: true })).toBe(2);
		expect((await joinedCases(reportId)).sort()).toEqual([failedRetrying.id, failedForGood.id, invalid.id].sort());
		expect(await collectSiteGroup("slon10.to", { includeSettled: true })).toBe(0);
	});

	test("a queued host whose domain was reported after it was queued is collected when its turn comes, not visited", async () => {
		const first = await createWebsiteSubmission({ url: "https://a.slon10.to/", ...REPORTER });
		const second = await createWebsiteSubmission({ url: "https://b.slon10.to/", ...REPORTER });
		// Another reporter's case of a third host was reported in the meantime, outside the queue's order.
		await reported("https://c.slon10.to/");
		const visited: string[] = [];
		expect(await runQueuedVisits(async (options) => { visited.push(options.url); })).toEqual([first.id, second.id]);
		expect(visited).toEqual([]);
		expect([(await caseOf(first.id)).status, (await caseOf(second.id)).status]).toEqual(["collected", "collected"]);
	});

	test("a scheduled automatic retry of a host whose domain was reported meanwhile is collected instead", async () => {
		const host = await createWebsiteSubmission({ url: "https://r.slon10.to/", ...REPORTER });
		await runQueuedVisits(async (options) => {
			const { failWebsiteAnalysis } = await import("../analysis/failure");
			await failWebsiteAnalysis(options.submissionId, { info: "The browser service failed.", retry: { attempts: 0, reason: "relay", exhausted: () => "" } });
		});
		const anchor = await reported("https://a.slon10.to/");
		expect(await runQueuedVisits(async () => { throw new Error("must not visit"); }, { all: true })).toEqual([host.id]);
		const collected = await caseOf(host.id);
		expect(collected.status).toBe("collected");
		expect(collected.data.kind === "website" && collected.data.website.autoRetry).toBeFalsy();
		expect(await joinedCases(anchor.reportId)).toEqual([host.id]);
	});
});

describe("hosts of a domain none of whose visited hosts showed anything", () => {
	test(`after ${SIBLING_TRIAL_LIMIT} distinct hosts, the rest are left unvisited until a host is reported`, async () => {
		for (let index = 0; index < SIBLING_TRIAL_LIMIT - 1; index++) {
			const { id } = await createWebsiteSubmission({ url: `https://h${index}.empty-kit-test.com/`, ...REPORTER });
			await SubmissionsEntity.update(id, { status: index % 2 ? "invalid" : "failed" });
		}
		// The same host again (a re-report) is no new host.
		const again = await createWebsiteSubmission({ url: "https://h0.empty-kit-test.com/", rereport: true, ...REPORTER });
		await SubmissionsEntity.update(again.id, { status: "invalid" });
		const fifth = await createWebsiteSubmission({ url: "https://h4.empty-kit-test.com/", ...REPORTER });
		expect(fifth.status).toBe("queued");
		await (await getDb()).delete(jobs).where(eq(jobs.dedupeKey, `website-visit:${fifth.id}`)).run();
		await SubmissionsEntity.update(fifth.id, { status: "invalid" });

		const sixth = await createWebsiteSubmission({ url: "https://h5.empty-kit-test.com/", ...REPORTER });
		expect(sixth.status).toBe("invalid");
		const left = await caseOf(sixth.id);
		expect(left.info).toBe(`Not visited: ${SIBLING_TRIAL_LIMIT} other hosts of empty-kit-test.com were visited and none showed a threat. Analyze it again to visit this host too.`);
		expect(left.data.kind === "website" && left.data.website.collected).toMatchObject({ reason: "siblings_inconclusive", tried: SIBLING_TRIAL_LIMIT });
		expect((await queuedVisits()).map((job) => job.payload?.submissionId)).not.toContain(sixth.id.toString());

		// A host visited by hand is reported: the unvisited host joins that report.
		const anchor = await reported("https://h9.empty-kit-test.com/");
		await collectSiblingsOf(anchor.id);
		expect((await caseOf(sixth.id)).status).toBe("collected");
		// Hosts visited and found harmless keep their own verdicts.
		expect(await joinedCases(anchor.reportId)).toEqual([sixth.id]);
	});
});

describe("visiting a collected host on its own", () => {
	test("releases it from its domain's report and visits it whatever the group says", async () => {
		const anchor = await reported("https://a.slon10.to/");
		const sibling = await createWebsiteSubmission({ url: "https://b.slon10.to/", ...REPORTER });
		(await getDb()).insert((await import("@/lib/campaign/schema")).campaigns).values({ id: 9n }).run();
		(await getDb()).insert((await import("@/lib/campaign/schema")).campaignMembers).values({ submissionId: sibling.id, reportId: anchor.reportId, campaignId: 9n }).run();

		await retryWebsiteAnalysis(sibling.id);

		const released = await caseOf(sibling.id);
		expect(released.status).toBe("queued");
		expect(released.data.kind === "website" && released.data.website.collected).toBeUndefined();
		expect(await joinedCases(anchor.reportId)).toEqual([]);
		expect((await getDb()).select().from((await import("@/lib/campaign/schema")).campaignMembers).all()).toEqual([]);
		expect((await AbuseRepository.listEvents(anchor.reportId)).map((event) => event.eventType)).toContain("report.case_released");
		const visited: string[] = [];
		expect(await runQueuedVisits(async (options) => { visited.push(options.url); })).toEqual([sibling.id]);
		expect(visited).toEqual(["https://b.slon10.to/"]);
	});
});

describe("one report per domain", () => {
	const report = async (submissionId: bigint, url: string) => {
		const host = new URL(url).hostname;
		const request = await validateAbuseReportRequest({ targets: [host], allegationCategory: "phishing", description: `Phishing on ${url}.`, observedUrls: [{ target: host, urls: [url] }] });
		return AbuseRepository.createReport({ request, reporter: {}, submissionId, subject: websiteReportSubject(url) });
	};
	const website = (id: bigint, url: string) => SubmissionsEntity.create({ id, kind: "website", data: { kind: "website", website: { url } }, dedupeKey: `website-${id}`, status: "reported" });

	test("a later case's host of a reported domain joins the first report; its own second host of the domain is its own report", async () => {
		await website(1n, "https://a.slon10.to/");
		await website(2n, "https://b.slon10.to/");
		const first = await report(1n, "https://a.slon10.to/");
		const later = await report(2n, "https://b.slon10.to/");
		expect(later).toMatchObject({ reportId: first.reportId, created: false, joined: { submissionId: 1n } });
		const own = await report(1n, "https://c.slon10.to/");
		expect(own.created).toBe(true);
		// The same site again is the case's own report, replayed.
		expect(await report(1n, "https://a.slon10.to/other")).toMatchObject({ reportId: first.reportId, created: false });
		expect((await report(1n, "https://a.slon10.to/other")).joined).toBeUndefined();
	});

	test("tenants of a platform are never one report", async () => {
		await website(1n, "https://one.pages.dev/");
		await website(2n, "https://two.pages.dev/");
		const first = await report(1n, "https://one.pages.dev/");
		const second = await report(2n, "https://two.pages.dev/");
		expect(second.created).toBe(true);
		expect(second.reportId).not.toBe(first.reportId);
	});
});

describe("the registrar mail", () => {
	const draft = (provenance: Record<string, unknown>, urls: string[]) => createAbuseEmailDraft({
		report: { id: 7n, allegationCategory: "phishing", description: "Credential phishing.", legalBrandUrl: null, submissionId: 1n, reporterName: null, reporterContactEmail: null },
		target: { normalizedTarget: "a.slon10.to", observedUrls: ["https://a.slon10.to/login"] },
		route: { providerDisplayName: "Registrar", resolverProvenance: provenance, resolutionSnapshot: {}, createdAt: new Date() },
		recipient: "abuse@registrar.example",
	}, { generateSummary: async () => undefined, groupHostUrls: async () => urls });

	test("lists the other hosts of the domain; a host's mail does not", async () => {
		expect(isRegistrarRoute({ resolverProvenance: { source: "registrar_rdap" } })).toBe(true);
		expect(isRegistrarRoute({ resolverProvenance: { source: "domain_rdap", registrarId: 1 } })).toBe(true);
		expect(isRegistrarRoute({ resolverProvenance: { source: "ip_rdap" } })).toBe(false);
		const registrar = await draft({ source: "registrar_rdap", email: "abuse@registrar.example" }, ["https://b.slon10.to/", "https://c.d.slon10.to/x"]);
		expect(registrar.body).toContain("Other hosts of slon10.to reported to us (the same domain, so the same registration):\n- https://b.slon10.to/\n- https://c.d.slon10.to/x");
		const hosting = await draft({ source: "ip_rdap", email: "abuse@host.example" }, ["https://b.slon10.to/"]);
		expect(hosting.body).not.toContain("Other hosts");
		const alone = await draft({ source: "registrar_rdap", email: "abuse@registrar.example" }, []);
		expect(alone.body).not.toContain("Other hosts");
	});
});

describe("the probe of a collected host", () => {
	const verdict = (value: ContentVerification["verdict"]) => ({ url: "", checkedAt: new Date().toISOString(), state: "online", detail: null, verdict: value, tier: "fetch" }) as unknown as ContentVerification;
	const setup = async () => {
		const anchor = await reported("https://a.slon10.to/login");
		const sibling = await createWebsiteSubmission({ url: "https://b.slon10.to/", ...REPORTER });
		return { anchor, sibling };
	};

	test("same content or gone: it stays collected, with what the probe saw", async () => {
		const { sibling } = await setup();
		await probeCollectedHost(sibling.id, { verify: async () => verdict("served") });
		const probed = await caseOf(sibling.id);
		expect(probed.status).toBe("collected");
		expect(probed.data.kind === "website" && probed.data.website.collected).toMatchObject({ probe: { verdict: "same" } });
		await probeCollectedHost(sibling.id, { verify: async () => verdict("gone") });
		expect((await caseOf(sibling.id)).data).toMatchObject({ website: { collected: { probe: { verdict: "gone" } } } });
	});

	test("nothing to tell when the reported host answers plain fetches with nothing either", async () => {
		const { sibling } = await setup();
		const urls: string[] = [];
		await probeCollectedHost(sibling.id, { verify: async (target) => { urls.push(target.url); return verdict("unverified"); } });
		expect(urls).toEqual(["https://b.slon10.to/", "https://a.slon10.to/login"]);
		expect((await caseOf(sibling.id)).data).toMatchObject({ website: { collected: { probe: { verdict: "unknown" } } } });
	});

	test("other content while the reported host still serves its own: released and visited on its own, past its group's report", async () => {
		const { anchor, sibling } = await setup();
		const options: unknown[] = [];
		await probeCollectedHost(sibling.id, { verify: async (target, opts) => { options.push(opts); return verdict(target.url.includes("a.slon10.to") ? "served" : "unverified"); } });
		// Nothing is recorded on the report: the probe is about another host.
		expect(options).toEqual([{ maxTier: "fetch", record: false }, { maxTier: "fetch", record: false }]);
		const released = await caseOf(sibling.id);
		expect(released.status).toBe("queued");
		expect(released.info).toBe("This host served other content than a.slon10.to, the reported host of slon10.to; it is visited on its own.");
		expect(await joinedCases(anchor.reportId)).toEqual([]);
		const [job] = await queuedVisits();
		expect(job?.payload).toEqual({ submissionId: sibling.id.toString(), trigger: "initial", revisit: true });
		const visited: string[] = [];
		expect(await runQueuedVisits(async (opts) => { visited.push(opts.url); })).toEqual([sibling.id]);
		expect(visited).toEqual(["https://b.slon10.to/"]);
	});

	test("a case no longer collected is not probed", async () => {
		const { sibling } = await setup();
		await retryWebsiteAnalysis(sibling.id);
		expect(await probeCollectedHost(sibling.id, { verify: async () => { throw new Error("must not fetch"); } })).toBeUndefined();
		expect((await getDb()).select().from(jobs).where(and(eq(jobs.jobType, "visit_website"), eq(jobs.status, "queued"))).all()).toHaveLength(1);
	});
});

describe("the clean-up of a flood visited host by host before the queue existed (the slon10.to one-off)", () => {
	test("collects every host but the reported and the one being visited; other domains are untouched", async () => {
		const status = async (url: string, value: "reported" | "invalid" | "failed" | "running", extra: Record<string, unknown> = {}) => {
			const { id } = await createWebsiteSubmission({ url, ...REPORTER });
			await (await getDb()).delete(jobs).where(eq(jobs.dedupeKey, `website-visit:${id}`)).run();
			await SubmissionsEntity.update(id, { status: value, data: { kind: "website", website: { url, ...extra } } });
			return id;
		};
		// Six hosts were reported before site groups: the first report stands for the domain.
		const reportedIds = [];
		for (let index = 0; index < 6; index++) reportedIds.push(await status(`https://r${index}.slon10.to/`, "reported"));
		const invalid = [];
		for (let index = 0; index < 9; index++) invalid.push(await status(`https://i${index}.slon10.to/`, "invalid"));
		const held = [];
		for (let index = 0; index < 5; index++) held.push(await status(`https://f${index}.slon10.to/`, "failed", { autoRetry: { attempts: 3, nextAttemptAt: new Date(Date.now() + 60_000).toISOString(), reason: "The server restarted during the visit." } }));
		const running = await status("https://busy.slon10.to/", "running");
		const other = await status("https://other-kit-test.com/", "invalid");
		const { reportId } = await reportCaseSite(reportedIds[0]!, "https://r0.slon10.to/");

		expect(await collectSiteGroup("slon10.to", { includeSettled: true })).toBe(9 + 5);
		expect((await joinedCases(reportId)).length).toBe(14);
		for (const id of [...invalid, ...held]) expect((await caseOf(id)).status).toBe("collected");
		// Reported hosts keep their verdicts (their campaign joins them by domain); the host being visited finishes.
		for (const id of reportedIds) expect((await caseOf(id)).status).toBe("reported");
		expect([(await caseOf(running)).status, (await caseOf(other)).status]).toEqual(["running", "invalid"]);
		expect((await jobsOf("probe_collected_host")).length).toBe(14);
	});
});

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/submissions/route";
import { campaignMembers, campaigns } from "@/lib/campaign/schema";
import { reportCaseSite } from "@/lib/campaign/test_sites";
import { getDb } from "@/lib/db";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { submissionStatus, type SubmissionData, type SubmissionStatus } from "@/lib/db/schema";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { parseSubmissionFilters, SubmissionFilterError, submissionFilterOf, SUBMISSION_FILTERS } from "./filters";
import { listSubmissionItems, SubmissionCursorError, type SubmissionListItem } from "./list";

useTemporaryDatabase();

async function create(id: bigint, createdAt: Date, data: SubmissionData, status: SubmissionStatus = "reported", siteGroup?: string) {
	await SubmissionsEntity.create({ id, kind: data.kind, data, dedupeKey: `list-${id}`, status, source: "test", siteGroup });
	await SubmissionsEntity.update(id, { createdAt });
}

/** A website case of `host` in site group `group`, created `at` ms after a fixed start. */
async function host(id: bigint, at: number, url: string, status: SubmissionStatus, group?: string) {
	await create(id, new Date(Date.parse("2026-11-01T00:00:00Z") + at), { kind: "website", website: { url } }, status, group);
}

/** Make each case a member of `campaignId` with one reported site. */
async function joinCampaign(campaignId: bigint, ids: bigint[]) {
	const db = await getDb();
	db.insert(campaigns).values({ id: campaignId }).onConflictDoNothing().run();
	for (const id of ids) {
		const { url } = ((await SubmissionsEntity.get(id))!.data as Extract<SubmissionData, { kind: "website" }>).website;
		const site = await reportCaseSite(id, url);
		db.insert(campaignMembers).values({ submissionId: site.submissionId, reportId: site.reportId, campaignId }).run();
	}
}

const ids = (items: SubmissionListItem[]) => items.map((item) => item.type === "submission" ? item.submission.id : item.newest.id);

/** One line per tile: what it is, what it counts, and the case it opens. */
const summary = (items: SubmissionListItem[]) => items.map((item) => item.type === "submission"
	? `case ${item.submission.title} ${item.submission.status}`
	: item.type === "campaign"
		? `campaign ${item.domain ?? "-"} ${item.siteCount} sites ${item.hostCount} hosts, ${item.pending} pending, newest ${item.newest.title}`
		: `group ${item.siteGroup} ${item.size} hosts, ${item.runningCount} running ${item.queuedCount} queued, newest ${item.newest.title} ${item.newest.status}`);

describe("submission list pages", () => {
	test("returns only card fields, newest first, with a title for every kind", async () => {
		await create(1n, new Date("2026-10-01T00:00:00Z"), { kind: "website", website: { url: "https://kit.example.com/login", whois: { ip_rdaps: [] } } });
		await create(2n, new Date("2026-10-02T00:00:00Z"), { kind: "email", email: { subject: "Your account is locked" } as never });
		await create(3n, new Date("2026-10-03T00:00:00Z"), { kind: "email", email: { subject: "" } as never });
		await SubmissionsEntity.update(1n, { reporterIp: "203.0.113.9", reporterHeaders: { "user-agent": "secret" } });

		const page = await listSubmissionItems();
		expect(page).toEqual({
			items: [
				{ type: "submission", key: "3", submission: { id: "3", kind: "email", status: "reported", createdAt: "2026-10-03T00:00:00.000Z", title: "list-3", reportedAs: "phishing" } },
				{ type: "submission", key: "2", submission: { id: "2", kind: "email", status: "reported", createdAt: "2026-10-02T00:00:00.000Z", title: "Your account is locked", reportedAs: "phishing" } },
				// A website reported before its verdicts were kept says only that it was reported.
				{ type: "submission", key: "1", submission: { id: "1", kind: "website", status: "reported", createdAt: "2026-10-01T00:00:00.000Z", title: "https://kit.example.com/login" } },
			],
			counts: { running: 0, reported: 3, no_threat: 0, failed: 0 },
		});
		// The reporter's IP and headers, and the full analysis data, are not part of the public list.
		expect(JSON.stringify(page)).not.toContain("203.0.113.9");
		expect(JSON.stringify(page)).not.toContain("whois");
	});

	test("never reads a case's data: a row whose data is not even JSON is listed", async () => {
		await create(1n, new Date("2026-10-01T00:00:00Z"), { kind: "website", website: { url: "https://kit.example.com/" } });
		(await getDb()).$client.run("UPDATE submissions SET data = 'not json' WHERE id = 1");
		expect(ids((await listSubmissionItems()).items)).toEqual(["1"]);
	});

	test("a reported case says what it was reported for, across every route: phishing, malware, both, or only the deceptive funnel its chain is", async () => {
		const funnel = { verdict: { finding: "deceptive_funnel" }, extraction: {} } as never;
		const hop = { hopIndex: 0, judgedHopIndex: 0 };
		const phishing = { ...hop, finding: "phishing" as const, phishingBasis: "credential_theft" as const, evidenceQuote: "Sign in" };
		const malware = { ...hop, finding: "malware" as const, evidenceQuote: "curl https://hostsync.pro/x | osascript" };
		await create(11n, new Date("2026-10-01T00:00:00Z"), { kind: "website", website: { url: "https://lure.com/", routes: [{ hops: [], funnel, siteAssessments: [{ ...hop, finding: "insufficient_evidence" }] }] } });
		await create(12n, new Date("2026-10-02T00:00:00Z"), { kind: "website", website: { url: "https://kit.com/", routes: [{ hops: [], funnel, siteAssessments: [phishing] }] } });
		await create(13n, new Date("2026-10-03T00:00:00Z"), { kind: "website", website: { url: "https://shop.com/", routes: [{ hops: [], funnel: { verdict: { finding: "not_deceptive" }, extraction: {} } as never }] } }, "invalid");
		// Production case 384401854580134038: a ClickFix clone is malware, not phishing.
		await create(14n, new Date("2026-10-04T00:00:00Z"), { kind: "website", website: { url: "https://trylevo.app/", routes: [{ hops: [], siteAssessments: [{ ...hop, finding: "benign" }] }, { hops: [], siteAssessments: [malware] }] } });
		await create(15n, new Date("2026-10-05T00:00:00Z"), { kind: "website", website: { url: "https://mixed.com/", routes: [{ hops: [], siteAssessments: [phishing] }, { hops: [], siteAssessments: [malware] }] } });
		// A malware verdict of a case that is not reported (yet) labels nothing.
		await create(16n, new Date("2026-10-06T00:00:00Z"), { kind: "website", website: { url: "https://running.com/", routes: [{ hops: [], siteAssessments: [malware] }] } }, "running");
		const { items } = await listSubmissionItems();
		expect(items.map((item) => item.type === "submission" ? { id: item.submission.id, reportedAs: item.submission.reportedAs } : item.key)).toEqual([
			{ id: "16", reportedAs: undefined },
			{ id: "15", reportedAs: "phishing_and_malware" },
			{ id: "14", reportedAs: "malware" },
			{ id: "13", reportedAs: undefined },
			{ id: "12", reportedAs: "phishing" },
			{ id: "11", reportedAs: "deceptive_funnel" },
		]);
	});

	test("pages through every submission exactly once, across equal timestamps and new arrivals", async () => {
		const base = Date.parse("2026-10-10T00:00:00Z");
		// 7 submissions; ids 13-15 share one timestamp so the id breaks the tie.
		const times = [base, base + 1, base + 2, base + 3, base + 3, base + 3, base + 4];
		for (const [index, time] of times.entries()) {
			await create(BigInt(10 + index), new Date(time), { kind: "website", website: { url: `https://site-${index}.example.com/` } });
		}

		const first = await listSubmissionItems({ limit: 3 });
		expect(ids(first.items)).toEqual(["16", "15", "14"]);
		expect(first.nextCursor).toBe(`${base + 3}.14`);

		// A submission arriving between page loads does not shift the older pages.
		await create(99n, new Date(base + 10), { kind: "website", website: { url: "https://new.example.com/" } });

		const second = await listSubmissionItems({ cursor: first.nextCursor, limit: 3 });
		expect(ids(second.items)).toEqual(["13", "12", "11"]);
		const third = await listSubmissionItems({ cursor: second.nextCursor, limit: 3 });
		expect(ids(third.items)).toEqual(["10"]);
		expect(third.nextCursor).toBeUndefined();

		const seen = ids([...first.items, ...second.items, ...third.items]);
		expect(new Set(seen).size).toBe(7);
	});

	test("every status belongs to exactly one chip", () => {
		for (const status of submissionStatus) {
			expect(Object.values(SUBMISSION_FILTERS).filter((statuses) => (statuses as readonly string[]).includes(status))).toHaveLength(1);
			expect((SUBMISSION_FILTERS[submissionFilterOf(status)] as readonly string[])).toContain(status);
		}
	});

	test("filters by status chip across pages, and counts every submission under its chip", async () => {
		const base = Date.parse("2026-10-30T00:00:00Z");
		const statuses = ["running", "reported", "invalid", "invalid", "failed", "failed", "reported", "invalid"] as const;
		for (const [index, status] of statuses.entries()) {
			await create(BigInt(300 + index), new Date(base + index), { kind: "website", website: { url: `https://s${index}.example.com/` } }, status);
		}
		const counts = { running: 1, reported: 2, no_threat: 3, failed: 2 };

		// The default chips: what is being analyzed now and what was confirmed, newest first.
		const first = await listSubmissionItems({ filters: ["running", "reported"], limit: 2 });
		expect(first.items.map((item) => item.type === "submission" ? `${item.submission.id}:${item.submission.status}` : item.key)).toEqual(["306:reported", "301:reported"]);
		expect(first.counts).toEqual(counts);
		const second = await listSubmissionItems({ filters: ["running", "reported"], limit: 2, cursor: first.nextCursor });
		expect(ids(second.items)).toEqual(["300"]);
		expect(second.nextCursor).toBeUndefined();
		// Older pages carry no counts; the newest page's refresh keeps them current.
		expect(second.counts).toBeUndefined();

		expect(ids((await listSubmissionItems({ filters: ["failed"] })).items)).toEqual(["305", "304"]);
		expect(ids((await listSubmissionItems({ filters: ["failed", "no_threat"] })).items)).toEqual(["307", "305", "304", "303", "302"]);
		// No chip lists nothing, but still counts everything.
		expect(await listSubmissionItems({ filters: [] })).toEqual({ items: [], counts });
		// Without a filter, everything is listed.
		expect((await listSubmissionItems()).items).toHaveLength(statuses.length);
	});

	test("the API takes chips as ?status= and refuses unknown ones", async () => {
		await create(400n, new Date("2026-11-01T00:00:00Z"), { kind: "website", website: { url: "https://a.example.com/" } }, "invalid");
		await create(401n, new Date("2026-11-01T00:00:01Z"), { kind: "website", website: { url: "https://b.example.com/" } }, "running");
		const get = (query: string) => GET(new NextRequest(`https://phishing.support/api/submissions${query}`));

		expect(ids((await (await get("?status=running,reported")).json()).items)).toEqual(["401"]);
		expect((await (await get("?status=")).json()).items).toEqual([]);
		expect((await (await get("")).json()).items).toHaveLength(2);
		// The chips are named for what a case was found to be, which covers malware: "phishing" is no chip.
		const refused = await get("?status=running,phishing");
		expect(refused.status).toBe(400);
		expect((await refused.json()).error).toBe('Unknown submission filter "phishing"; use running, reported, no_threat, failed.');
		expect((await get("?cursor=abc")).status).toBe(400);

		expect(parseSubmissionFilters(" running , running,failed,")).toEqual(["running", "failed"]);
		expect(() => parseSubmissionFilters("__proto__")).toThrow(SubmissionFilterError);
	});

	test("bounds the page size and rejects a malformed cursor", async () => {
		for (let index = 0; index < 3; index++) {
			await create(BigInt(200 + index), new Date(Date.parse("2026-10-20T00:00:00Z") + index), { kind: "website", website: { url: `https://p${index}.example.com/` } });
		}
		expect((await listSubmissionItems({ limit: 0 })).items).toHaveLength(1);
		expect((await listSubmissionItems({ limit: 1_000 })).items).toHaveLength(3);
		for (const cursor of ["abc", "1.2.3", "-1.5", `${"9".repeat(16)}.1`]) {
			await expect(listSubmissionItems({ cursor })).rejects.toBeInstanceOf(SubmissionCursorError);
		}
	});
});

describe("the list's tiles", () => {
	test("a flood of one domain's hosts is one tile, and a page still holds `limit` distinct tiles that page on with no gaps or repeats", async () => {
		// 105 failed slon10.to hosts arrive one after the other, between ten other sites.
		for (let index = 0; index < 5; index++) await host(BigInt(1 + index), index, `https://old-${index}.example/`, "reported");
		for (let index = 0; index < 105; index++) await host(BigInt(100 + index), 10 + index, `https://h${index}.slon10.to/`, index === 104 ? "running" : "failed", "slon10.to");
		for (let index = 0; index < 5; index++) await host(BigInt(500 + index), 200 + index, `https://new-${index}.example/`, "reported");

		const first = await listSubmissionItems({ limit: 4 });
		expect(summary(first.items)).toEqual(["case https://new-4.example/ reported", "case https://new-3.example/ reported", "case https://new-2.example/ reported", "case https://new-1.example/ reported"]);
		const second = await listSubmissionItems({ limit: 4, cursor: first.nextCursor });
		expect(summary(second.items)).toEqual([
			"case https://new-0.example/ reported",
			"group slon10.to 105 hosts, 1 running 0 queued, newest https://h104.slon10.to/ running",
			"case https://old-4.example/ reported",
			"case https://old-3.example/ reported",
		]);
		const third = await listSubmissionItems({ limit: 4, cursor: second.nextCursor });
		expect(summary(third.items)).toEqual(["case https://old-2.example/ reported", "case https://old-1.example/ reported", "case https://old-0.example/ reported"]);
		expect(third.nextCursor).toBeUndefined();
		const keys = [...first.items, ...second.items, ...third.items].map((item) => item.key);
		expect(new Set(keys).size).toBe(11);

		// The failed chip alone: the group counts only its failed hosts.
		expect(summary((await listSubmissionItems({ filters: ["failed"] })).items)).toEqual(["group slon10.to 104 hosts, 0 running 0 queued, newest https://h103.slon10.to/ failed"]);
	});

	test("a domain's campaign is one tile named by the domain, with its hosts still waiting or in their visit", async () => {
		await host(1n, 1, "https://a.slon10.to/", "reported", "slon10.to");
		await host(2n, 2, "https://r1.slon10.to/", "running", "slon10.to");
		await host(3n, 3, "https://solo.example/", "running", "solo.example");
		await host(4n, 4, "https://b.slon10.to/", "collected", "slon10.to");
		await host(5n, 5, "https://q1.slon10.to/", "queued", "slon10.to");
		await joinCampaign(7n, [1n, 4n]);

		expect(summary((await listSubmissionItems()).items)).toEqual([
			"campaign slon10.to 2 sites 2 hosts, 2 pending, newest https://q1.slon10.to/",
			"case https://solo.example/ running",
		]);
		const [campaign] = (await listSubmissionItems()).items;
		expect(campaign).toMatchObject({ type: "campaign", key: "campaign-7", campaignId: "7", domain: "slon10.to" });
		// With only the running chip, the campaign's reported hosts are not listed: its waiting hosts are their domain's tile.
		expect(summary((await listSubmissionItems({ filters: ["running"] })).items)).toEqual([
			"group slon10.to 2 hosts, 1 running 1 queued, newest https://q1.slon10.to/ queued",
			"case https://solo.example/ running",
		]);
	});

	test("a campaign of several domains keeps its own cases: a domain's other hosts are their group's tile, a lone one a plain card", async () => {
		await host(1n, 1, "https://a.slon7.at/", "reported", "slon7.at");
		await host(2n, 2, "https://kit-other.com/", "reported", "kit-other.com");
		await host(3n, 3, "https://b.slon7.at/", "reported", "slon7.at");
		await host(4n, 4, "https://c.slon7.at/", "reported", "slon7.at");
		await host(5n, 5, "https://a.slon10.to/", "reported", "slon10.to");
		await joinCampaign(8n, [1n, 2n, 3n, 4n, 5n]);
		await host(6n, 6, "https://failed.slon7.at/", "failed", "slon7.at");
		for (let index = 0; index < 3; index++) await host(BigInt(10 + index), 10 + index, `https://f${index}.slon10.to/`, "failed", "slon10.to");
		// Tenants of one platform are groups of their own.
		await host(20n, 20, "https://one.pages.dev/", "queued", "one.pages.dev");
		await host(21n, 21, "https://two.pages.dev/", "queued", "two.pages.dev");

		const { items } = await listSubmissionItems();
		expect(summary(items)).toEqual([
			"case https://two.pages.dev/ queued",
			"case https://one.pages.dev/ queued",
			"group slon10.to 3 hosts, 0 running 0 queued, newest https://f2.slon10.to/ failed",
			"case https://failed.slon7.at/ failed",
			"campaign - 5 sites 5 hosts, 0 pending, newest https://a.slon10.to/",
		]);
		expect(items.find((item) => item.type === "campaign")).not.toHaveProperty("domain");
	});

	test("a case of several sites counts once as a host and once per site", async () => {
		await host(1n, 1, "https://a.slon10.to/", "reported", "slon10.to");
		await host(2n, 2, "https://b.slon10.to/", "reported", "slon10.to");
		await joinCampaign(9n, [1n, 2n]);
		// Case 2's flow also led to a kit page on another site, a member of its own.
		const kit = await reportCaseSite(2n, "https://kit-elsewhere.com/");
		(await getDb()).insert(campaignMembers).values({ submissionId: 2n, reportId: kit.reportId, campaignId: 9n }).run();
		expect(summary((await listSubmissionItems()).items)).toEqual(["campaign slon10.to 3 sites 2 hosts, 0 pending, newest https://b.slon10.to/"]);
	});
});

describe("a case's title and what it is reported for stay in step with its data", () => {
	const hop = { hopIndex: 0, judgedHopIndex: 0 };
	const routes = (finding: "phishing" | "malware" | "benign") => [{ hops: [], siteAssessments: [{ ...hop, finding, evidenceQuote: "x" }] }] as never;
	const stored = async (id: bigint) => {
		const row = (await SubmissionsEntity.get(id))!;
		return { title: row.title, reportedAs: row.reportedAs };
	};

	test("on create, update and setWebsiteField", async () => {
		await create(1n, new Date("2026-10-01T00:00:00Z"), { kind: "website", website: { url: "https://kit.example/", routes: routes("phishing") } });
		expect(await stored(1n)).toEqual({ title: "https://kit.example/", reportedAs: "phishing" });

		await SubmissionsEntity.update(1n, { data: { kind: "website", website: { url: "https://kit.example/next", routes: routes("malware") } } });
		expect(await stored(1n)).toEqual({ title: "https://kit.example/next", reportedAs: "malware" });

		// A funnel verdict set in place labels a case that found no site, and taking it back clears it.
		await SubmissionsEntity.update(1n, { data: { kind: "website", website: { url: "https://kit.example/next", routes: routes("benign") } } });
		expect((await stored(1n)).reportedAs).toBeNull();
		await SubmissionsEntity.setWebsiteField(1n, "routes[0].funnel", { verdict: { finding: "deceptive_funnel" }, extraction: {} });
		expect((await stored(1n)).reportedAs).toBe("deceptive_funnel");
		await SubmissionsEntity.setWebsiteField(1n, "routes[0].funnel", { verdict: { finding: "not_deceptive" }, extraction: {} });
		expect((await stored(1n)).reportedAs).toBeNull();
		// A field that is no verdict changes nothing of it.
		await SubmissionsEntity.setWebsiteField(1n, "routes[0].funnel", { verdict: { finding: "deceptive_funnel" }, extraction: {} });
		await SubmissionsEntity.setWebsiteField(1n, "accessGate", { kind: "none" });
		expect(await stored(1n)).toEqual({ title: "https://kit.example/next", reportedAs: "deceptive_funnel" });

		// An update that names the title itself keeps it.
		await SubmissionsEntity.update(1n, { data: { kind: "website", website: { url: "https://kit.example/" } }, title: "kept" });
		expect((await stored(1n)).title).toBe("kept");
	});

	test("an email without a subject is named by its dedupe key, the stored one or a new one", async () => {
		await create(2n, new Date("2026-10-01T00:00:00Z"), { kind: "email", email: { subject: "" } as never });
		expect(await stored(2n)).toEqual({ title: "list-2", reportedAs: "phishing" });
		await SubmissionsEntity.update(2n, { data: { kind: "email", email: { subject: "Invoice" } as never } });
		expect((await stored(2n)).title).toBe("Invoice");
		await SubmissionsEntity.update(2n, { data: { kind: "email", email: { subject: "" } as never } });
		expect((await stored(2n)).title).toBe("list-2");
		await SubmissionsEntity.update(2n, { dedupeKey: "renamed" });
		expect((await stored(2n)).title).toBe("renamed");
		await SubmissionsEntity.update(2n, { data: { kind: "email", email: {} as never }, dedupeKey: "both" });
		expect((await stored(2n)).title).toBe("both");
	});
});

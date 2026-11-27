import { describe, expect, test } from "bun:test";

import { campaignMembers, campaigns } from "@/lib/campaign/schema";
import { reportCaseSite } from "@/lib/campaign/test_sites";
import { getDb } from "@/lib/db";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import type { SubmissionStatus } from "@/lib/db/schema";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { groupCards } from "./campaign_groups";
import { listSubmissionCards, type SubmissionCard } from "./list";
import { createWebsiteSubmission } from "./website";

useTemporaryDatabase();

let at = 1_000;
const card = (id: string, status: SubmissionStatus, extra: Partial<SubmissionCard> = {}): SubmissionCard => ({ id, kind: "website", status, createdAt: new Date(at--).toISOString(), title: `https://${id}/`, ...extra });
const summary = (cards: SubmissionCard[]) => groupCards(cards).map((item) => item.type === "submission"
	? item.submission.id
	: item.type === "campaign"
		? `campaign ${item.domain ?? "-"} ${item.hostCount} hosts, ${item.titles.length} loaded, ${item.pending} pending, newest ${item.newest.id}`
		: `group ${item.siteGroup} ${item.size} hosts [${item.statuses.join(",")}] newest ${item.newest.id}`);

describe("groupCards", () => {
	test("a domain's campaign is one tile named by the domain, with its waiting hosts, wherever they are in the list", () => {
		const slon = { id: "7", siteCount: 90, hostCount: 90, domain: "slon10.to" };
		expect(summary([
			card("q1.slon10.to", "queued", { siteGroup: { key: "slon10.to", size: 92 } }),
			card("a.slon10.to", "collected", { campaign: slon, siteGroup: { key: "slon10.to", size: 92 } }),
			card("solo.example", "running"),
			card("r1.slon10.to", "running", { siteGroup: { key: "slon10.to", size: 92 } }),
			card("b.slon10.to", "reported", { campaign: slon, siteGroup: { key: "slon10.to", size: 92 } }),
		])).toEqual([
			"campaign slon10.to 90 hosts, 2 loaded, 2 pending, newest q1.slon10.to",
			"solo.example",
		]);
	});

	test("a group's hosts in no campaign are one tile; a lone host and a group of one are plain cards", () => {
		expect(summary([
			card("a.flood-test.com", "running", { siteGroup: { key: "flood-test.com", size: 3 } }),
			card("lone.example", "queued", { siteGroup: { key: "lone.example", size: 1 } }),
			card("b.flood-test.com", "queued", { siteGroup: { key: "flood-test.com", size: 3 } }),
			card("email", "running", { kind: "email" }),
		])).toEqual([
			"group flood-test.com 3 hosts [running,queued] newest a.flood-test.com",
			"lone.example",
			"email",
		]);
	});

	test("a campaign of several domains keeps its sites tile; tenants of one platform are separate groups", () => {
		const mixed = { id: "8", siteCount: 2, hostCount: 2 };
		expect(summary([
			card("kit-one.example", "reported", { campaign: mixed }),
			card("one.pages.dev", "queued", { siteGroup: { key: "one.pages.dev", size: 1 } }),
			card("kit-two.example", "reported", { campaign: mixed }),
			card("two.pages.dev", "queued", { siteGroup: { key: "two.pages.dev", size: 1 } }),
		])).toEqual([
			"campaign - 2 hosts, 2 loaded, 0 pending, newest kit-one.example",
			"one.pages.dev",
			"two.pages.dev",
		]);
	});
});

describe("the list's cards", () => {
	test("carry the campaign's domain and host count, and the site group's size", async () => {
		const ids: bigint[] = [];
		for (const host of ["a.slon10.to", "b.slon10.to"]) {
			const { id } = await createWebsiteSubmission({ url: `https://${host}/` });
			await SubmissionsEntity.update(id, { status: "reported" });
			ids.push(id);
		}
		const other = await createWebsiteSubmission({ url: "https://kit-other-test.com/" });
		await SubmissionsEntity.update(other.id, { status: "reported" });
		const db = await getDb();
		db.insert(campaigns).values([{ id: 1n }, { id: 2n }]).run();
		const one = await reportCaseSite(ids[0]!, "https://a.slon10.to/");
		const two = await reportCaseSite(ids[1]!, "https://b.slon10.to/");
		const three = await reportCaseSite(other.id, "https://kit-other-test.com/");
		db.insert(campaignMembers).values([
			{ submissionId: one.submissionId, reportId: one.reportId, campaignId: 1n },
			{ submissionId: two.submissionId, reportId: two.reportId, campaignId: 1n },
			{ submissionId: three.submissionId, reportId: three.reportId, campaignId: 2n },
		]).run();
		const waiting = await createWebsiteSubmission({ url: "https://c.slon10.to/" });

		const { submissions } = await listSubmissionCards();
		const byId = new Map(submissions.map((entry) => [entry.id, entry]));
		expect(byId.get(ids[0]!.toString())).toMatchObject({ campaign: { id: "1", siteCount: 2, hostCount: 2, domain: "slon10.to" }, siteGroup: { key: "slon10.to", size: 3 } });
		expect(byId.get(other.id.toString())?.campaign).toEqual({ id: "2", siteCount: 1, hostCount: 1, domain: "kit-other-test.com" });
		// The third host of the domain was collected into the domain's report when it came in.
		expect(byId.get(waiting.id.toString())).toMatchObject({ status: "collected", siteGroup: { key: "slon10.to", size: 3 } });
	});
});

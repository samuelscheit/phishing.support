import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { claimNextJob } from "@/lib/abuse/persistence/jobs";
import { jobs } from "@/lib/abuse/schema";
import { getDb } from "@/lib/db";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { createWebsiteSubmission } from "@/lib/submissions/website";
import { fairSharePosition, websiteVisitQueueState } from "./position";
import { visitJobKey } from "./queue";

useTemporaryDatabase();

const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 0, minute));
const line = (...keys: string[]) => keys.map((fairKey, index) => ({ id: BigInt(index + 1), fairKey, nextAttemptAt: at(index), createdAt: at(index) }));

describe("fairSharePosition", () => {
	test("one reporter's line is first come, first served", () => {
		const queue = line("a", "a", "a");
		expect([1n, 2n, 3n].map((id) => fairSharePosition(queue, id))).toEqual([1, 2, 3]);
	});

	test("a later reporter's first job comes right after the flood's first, not behind the whole flood", () => {
		const queue = line(...Array.from({ length: 100 }, () => "flood"), "other", "other");
		expect(fairSharePosition(queue, 101n)).toBe(2);
		expect(fairSharePosition(queue, 102n)).toBe(4);
		// The flood's third job waits behind both of the other reporter's.
		expect(fairSharePosition(queue, 3n)).toBe(5);
		expect(fairSharePosition(queue, 100n)).toBe(102);
	});

	test("unequal keys: each other key counts at most as many turns as the job's own", () => {
		const queue = line("a", "b", "b", "b", "c", "a");
		expect(fairSharePosition(queue, 6n)).toBe(5);
		expect(fairSharePosition(queue, 5n)).toBe(3);
		expect(fairSharePosition(queue, 99n)).toBeUndefined();
	});
});

describe("websiteVisitQueueState", () => {
	test("reports the place in line, the due time of a scheduled retry, and nothing once the visit started", async () => {
		const flood = [];
		for (let index = 0; index < 3; index++) flood.push(await createWebsiteSubmission({ url: `https://h${index}.flood.example/`, reporterIp: "5.189.203.86" }));
		const other = await createWebsiteSubmission({ url: "https://other.example/", reporterIp: "192.0.2.1" });
		expect(await websiteVisitQueueState(other.id)).toEqual({ kind: "queued", position: 2 });
		expect(await websiteVisitQueueState(flood[2]!.id)).toEqual({ kind: "queued", position: 4 });

		const later = new Date(Date.now() + 30 * 60_000);
		(await getDb()).update(jobs).set({ nextAttemptAt: later }).where(eq(jobs.dedupeKey, visitJobKey(flood[1]!.id))).run();
		expect(await websiteVisitQueueState(flood[1]!.id)).toEqual({ kind: "scheduled", notBefore: later.toISOString() });

		await claimNextJob("worker", 60_000, { jobTypes: ["visit_website"] });
		expect(await websiteVisitQueueState(flood[0]!.id)).toBeUndefined();
		expect(await websiteVisitQueueState(404n)).toBeUndefined();
	});

	test("a job whose serial key another case's visit holds says which case it waits for", async () => {
		const first = await createWebsiteSubmission({ url: "https://a.slon10.to/" });
		const second = await createWebsiteSubmission({ url: "https://b.slon10.to/" });
		(await getDb()).update(jobs).set({ serialKey: "site:slon10.to" }).run();
		await claimNextJob("worker", 60_000, { jobTypes: ["visit_website"] });
		expect(await websiteVisitQueueState(second.id)).toEqual({ kind: "waiting", forSubmissionId: first.id.toString() });
	});
});

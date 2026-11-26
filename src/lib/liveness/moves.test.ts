import { describe, expect, test } from "bun:test";

import { currentMove, HOST_MOVED_EVENT, hostMovesOf, hostMoveText, networkLabel, type HostMove } from "./moves";

const move = (overrides: Partial<HostMove> = {}): HostMove => ({
	key: "1:routed:cdn:Cloudflare->as:43641",
	targetId: "1",
	at: "2026-11-26T21:30:05.000Z",
	since: "2026-11-26T18:50:04.000Z",
	kind: "left_cdn",
	from: { name: "Cloudflare", cdn: "Cloudflare", asn: 13335, addresses: ["188.114.96.2"] },
	to: { name: "Sollutium-NL", asn: 43641, holder: "Sollutium-NL SOLLUTIUM EU Sp z.o.o.", addresses: ["85.137.52.128"] },
	content: "served",
	evidence: { url: "https://trylevo.app/", state: "online", httpStatus: 200, kitFiles: [] },
	...overrides,
});

describe("the words for a move, shared by the case and the campaign page", () => {
	test("where it went, when, and that it still serves what was reported", () => {
		expect(hostMoveText(move(), "malware")).toBe("Moved to Sollutium-NL (AS43641) at 26 Nov 21:30 UTC — still serving malware");
		expect(hostMoveText(move(), "phishing")).toBe("Moved to Sollutium-NL (AS43641) at 26 Nov 21:30 UTC — still serving the phishing page");
		expect(hostMoveText(move(), "malware", "de")).toBe("Umgezogen zu Sollutium-NL (AS43641) am 26. Nov. 21:30 UTC – verbreitet weiter Schadsoftware");
	});

	test("a CDN by its name; content that is gone or was not compared", () => {
		expect(networkLabel({ name: "Fastly", cdn: "Fastly", asn: 54113 })).toBe("Fastly");
		expect(hostMoveText(move({ content: "gone" }), "malware")).toBe("Moved to Sollutium-NL (AS43641) at 26 Nov 21:30 UTC — the reported content is no longer there");
		expect(hostMoveText(move({ content: "unknown" }), "malware")).toBe("Moved to Sollutium-NL (AS43641) at 26 Nov 21:30 UTC");
	});
});

describe("reading moves from events", () => {
	test("a move confirmed later replaces its earlier record; other events and malformed data are skipped", () => {
		const gone = move({ content: "gone" });
		const served = move({ at: "2026-11-26T22:30:00.000Z" });
		const other = move({ key: "1:check:9:as:43641->as:213230", kind: "new_network" });
		expect(hostMovesOf([
			{ eventType: HOST_MOVED_EVENT, data: gone },
			{ eventType: "job.queued", data: {} },
			{ eventType: HOST_MOVED_EVENT, data: { key: "broken" } },
			{ eventType: HOST_MOVED_EVENT, data: served },
			{ eventType: HOST_MOVED_EVENT, data: other },
		])).toEqual([served, other]);
	});
});

describe("where the site stands now", () => {
	test("the latest move while it serves, until a later check finds the site down", () => {
		expect(currentMove([move()], null)).toEqual(move());
		expect(currentMove([move()], { state: "online", checkedAt: new Date("2026-11-27T01:00:00Z") })).toEqual(move());
		// The check that found the move itself, or one before it, says nothing after it.
		expect(currentMove([move()], { state: "cdn_blocked", checkedAt: new Date("2026-11-26T21:30:05Z") })).toEqual(move());
		expect(currentMove([move()], { state: "host_suspended", checkedAt: new Date("2026-11-27T01:00:00Z") })).toBeUndefined();
		expect(currentMove([move({ content: "gone" })], null)).toBeUndefined();
		expect(currentMove([move(), move({ key: "later", content: "unknown" })], null)).toBeUndefined();
		expect(currentMove([], null)).toBeUndefined();
	});
});

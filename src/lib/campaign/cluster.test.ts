import { describe, expect, test } from "bun:test";

import { assignCampaigns, type ClusterLink } from "./cluster";

function ids(start: bigint) {
	let next = start;
	return () => next++;
}

const link = (member: string, key: string): ClusterLink => ({ member, key });

describe("campaign clustering", () => {
	test("links sites that share an indicator, also through other sites", () => {
		const result = assignCampaigns({
			links: [link("1", "bot:a"), link("2", "bot:a"), link("2", "kit:x"), link("3", "kit:x"), link("4", "iban:y")],
			existing: new Map(),
			newId: ids(100n),
		});
		expect(result.membership.get("1")).toBe(result.membership.get("3")!);
		expect(result.membership.get("2")).toBe(result.membership.get("1")!);
		expect(result.membership.get("4")).not.toBe(result.membership.get("1")!);
		expect(result.created).toHaveLength(2);
		expect(result.merged.size).toBe(0);
	});

	test("a site alone with a strong indicator is a campaign of one; so is a confirmed site without any", () => {
		const result = assignCampaigns({ links: [link("7", "bot:solo")], existing: new Map(), newId: ids(1n) });
		expect([...result.membership]).toEqual([["7", 1n]]);
		const withSites = assignCampaigns({ links: [link("7", "bot:solo"), link("9", "bot:solo")], sites: ["7", "8", "9"], existing: new Map([["8", 40n]]), newId: ids(1n) });
		expect(withSites.membership.get("7")).toBe(withSites.membership.get("9")!);
		// A site without a linking indicator keeps the campaign of one it already had.
		expect(withSites.membership.get("8")).toBe(40n);
		expect(withSites.created).toEqual([1n]);
	});

	test("a site that gains a link leaves its campaign of one for the other's campaign", () => {
		const result = assignCampaigns({ links: [link("1", "kit:x"), link("2", "kit:x")], sites: ["1", "2"], existing: new Map([["1", 10n], ["2", 20n]]), newId: ids(900n) });
		expect([...result.membership.values()]).toEqual([10n, 10n]);
		expect([...result.merged]).toEqual([[20n, 10n]]);
	});

	test("a growing campaign keeps its id; a new site joins it", () => {
		const result = assignCampaigns({
			links: [link("1", "bot:a"), link("2", "bot:a"), link("3", "bot:a")],
			existing: new Map([["1", 50n], ["2", 50n]]),
			newId: ids(900n),
		});
		expect([...result.membership.values()]).toEqual([50n, 50n, 50n]);
		expect(result.created).toEqual([]);
	});

	test("two campaigns a new site bridges merge into the older one", () => {
		const result = assignCampaigns({
			links: [link("1", "bot:a"), link("2", "kit:x"), link("3", "bot:a"), link("3", "kit:x")],
			existing: new Map([["1", 60n], ["2", 40n]]),
			newId: ids(900n),
		});
		expect(new Set(result.membership.values())).toEqual(new Set([40n]));
		expect([...result.merged]).toEqual([[60n, 40n]]);
	});

	test("when a campaign splits, the larger part keeps the id and the other gets a new one", () => {
		// Sites 1-3 shared a bot with 4-5 through a kit hash that was since found to be a library.
		const result = assignCampaigns({
			links: [link("1", "bot:a"), link("2", "bot:a"), link("3", "bot:a"), link("4", "bot:b"), link("5", "bot:b")],
			existing: new Map([["1", 70n], ["2", 70n], ["3", 70n], ["4", 70n], ["5", 70n]]),
			newId: ids(900n),
		});
		expect(result.membership.get("1")).toBe(70n);
		expect(result.membership.get("4")).toBe(900n);
		expect(result.membership.get("5")).toBe(900n);
		expect(result.created).toEqual([900n]);
		expect(result.merged.size).toBe(0);
	});

	test("the same links give the same grouping regardless of their order", () => {
		const links = [link("3", "kit:x"), link("1", "bot:a"), link("2", "kit:x"), link("2", "bot:a"), link("9", "iban:z")];
		const forward = assignCampaigns({ links, existing: new Map(), newId: ids(1n) });
		const reversed = assignCampaigns({ links: [...links].reverse(), existing: new Map(), newId: ids(1n) });
		const groups = (membership: Map<string, bigint>) => [...membership].reduce((all, [site, campaign]) => all.set(campaign, [...(all.get(campaign) ?? []), site].sort()), new Map<bigint, string[]>());
		expect(new Set([...groups(forward.membership).values()].map(String))).toEqual(new Set([...groups(reversed.membership).values()].map(String)));
	});
});

import { describe, expect, test } from "bun:test";

import { assignCampaigns, type ClusterLink } from "./cluster";

function ids(start: bigint) {
	let next = start;
	return () => next++;
}

const link = (submissionId: bigint, key: string): ClusterLink => ({ submissionId, key });

describe("campaign clustering", () => {
	test("links sites that share an indicator, also through other sites", () => {
		const result = assignCampaigns({
			links: [link(1n, "bot:a"), link(2n, "bot:a"), link(2n, "kit:x"), link(3n, "kit:x"), link(4n, "iban:y")],
			existing: new Map(),
			newId: ids(100n),
		});
		expect(result.membership.get(1n)).toBe(result.membership.get(3n)!);
		expect(result.membership.get(2n)).toBe(result.membership.get(1n)!);
		expect(result.membership.get(4n)).not.toBe(result.membership.get(1n)!);
		expect(result.created).toHaveLength(2);
		expect(result.merged.size).toBe(0);
	});

	test("a site alone with a strong indicator is a campaign of one; a site without one is none", () => {
		const result = assignCampaigns({ links: [link(7n, "bot:solo")], existing: new Map(), newId: ids(1n) });
		expect([...result.membership]).toEqual([[7n, 1n]]);
		expect(result.membership.has(8n)).toBe(false);
	});

	test("a growing campaign keeps its id; a new site joins it", () => {
		const result = assignCampaigns({
			links: [link(1n, "bot:a"), link(2n, "bot:a"), link(3n, "bot:a")],
			existing: new Map([[1n, 50n], [2n, 50n]]),
			newId: ids(900n),
		});
		expect([...result.membership.values()]).toEqual([50n, 50n, 50n]);
		expect(result.created).toEqual([]);
	});

	test("two campaigns a new site bridges merge into the older one", () => {
		const result = assignCampaigns({
			links: [link(1n, "bot:a"), link(2n, "kit:x"), link(3n, "bot:a"), link(3n, "kit:x")],
			existing: new Map([[1n, 60n], [2n, 40n]]),
			newId: ids(900n),
		});
		expect(new Set(result.membership.values())).toEqual(new Set([40n]));
		expect([...result.merged]).toEqual([[60n, 40n]]);
	});

	test("when a campaign splits, the larger part keeps the id and the other gets a new one", () => {
		// Sites 1-3 shared a bot with 4-5 through a kit hash that was since found to be a library.
		const result = assignCampaigns({
			links: [link(1n, "bot:a"), link(2n, "bot:a"), link(3n, "bot:a"), link(4n, "bot:b"), link(5n, "bot:b")],
			existing: new Map([[1n, 70n], [2n, 70n], [3n, 70n], [4n, 70n], [5n, 70n]]),
			newId: ids(900n),
		});
		expect(result.membership.get(1n)).toBe(70n);
		expect(result.membership.get(4n)).toBe(900n);
		expect(result.membership.get(5n)).toBe(900n);
		expect(result.created).toEqual([900n]);
		expect(result.merged.size).toBe(0);
	});

	test("the same links give the same grouping regardless of their order", () => {
		const links = [link(3n, "kit:x"), link(1n, "bot:a"), link(2n, "kit:x"), link(2n, "bot:a"), link(9n, "iban:z")];
		const forward = assignCampaigns({ links, existing: new Map(), newId: ids(1n) });
		const reversed = assignCampaigns({ links: [...links].reverse(), existing: new Map(), newId: ids(1n) });
		const groups = (membership: Map<bigint, bigint>) => [...membership].reduce((all, [site, campaign]) => all.set(campaign, [...(all.get(campaign) ?? []), site].sort()), new Map<bigint, bigint[]>());
		expect(new Set([...groups(forward.membership).values()].map(String))).toEqual(new Set([...groups(reversed.membership).values()].map(String)));
	});
});

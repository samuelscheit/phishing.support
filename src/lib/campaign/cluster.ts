/**
 * Group members (a case's confirmed site, by `memberKey`) into campaigns:
 * two members belong together when they share any linking indicator,
 * directly or through others. Campaign ids are stable: a group keeps the
 * oldest campaign id among its members, so a case already reported under
 * that id keeps it as the campaign grows.
 */
export type ClusterLink = { member: string; key: string };

export type ClusterAssignment = {
	/** Campaign id per member. */
	membership: Map<string, bigint>;
	/** Campaigns that lost all their members to another one: old id → id that absorbed it. */
	merged: Map<bigint, bigint>;
	/** Campaign ids that `newId` created. */
	created: bigint[];
};

class DisjointSet {
	private readonly parent = new Map<string, string>();

	find(value: string): string {
		let root = value;
		while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
		let current = value;
		while (current !== root) {
			const next = this.parent.get(current) ?? root;
			this.parent.set(current, root);
			current = next;
		}
		if (!this.parent.has(root)) this.parent.set(root, root);
		return root;
	}

	union(a: string, b: string): void {
		const rootA = this.find(a);
		const rootB = this.find(b);
		if (rootA !== rootB) this.parent.set(rootA > rootB ? rootA : rootB, rootA < rootB ? rootA : rootB);
	}
}

/**
 * Assign every confirmed site to a campaign: sites that share a linking
 * indicator form one, and a site that shares none is a campaign of its own,
 * so every site can be referred to an authority.
 * `existing` is the current membership; every member of a group moves to the
 * group's oldest existing campaign (ids are time-ordered snowflakes), and a
 * group without one gets `newId()`. A campaign left without members by this
 * is reported as merged into the one its members moved to.
 */
export function assignCampaigns(params: {
	links: readonly ClusterLink[];
	/** Every confirmed site, also those without a linking indicator. */
	sites?: readonly string[];
	existing: ReadonlyMap<string, bigint>;
	newId: () => bigint;
}): ClusterAssignment {
	const sets = new DisjointSet();
	const firstByKey = new Map<string, string>();
	const linked = new Set<string>(params.sites ?? []);
	for (const site of linked) sets.find(site);
	for (const link of params.links) {
		linked.add(link.member);
		sets.find(link.member);
		const first = firstByKey.get(link.key);
		if (first === undefined) firstByKey.set(link.key, link.member);
		else sets.union(first, link.member);
	}

	const groups = new Map<string, string[]>();
	for (const member of [...linked].sort()) {
		const root = sets.find(member);
		groups.set(root, [...(groups.get(root) ?? []), member]);
	}

	const membership = new Map<string, bigint>();
	const merged = new Map<bigint, bigint>();
	const created: bigint[] = [];
	const used = new Set<bigint>();
	// The largest groups choose first, so when a campaign splits, the part with
	// most of its sites keeps the id its referrals were filed under.
	const ordered = [...groups.values()].sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
	for (const members of ordered) {
		const previous = [...new Set(members.map((member) => params.existing.get(member)).filter((id): id is bigint => id !== undefined))]
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		let campaignId = previous.find((id) => !used.has(id));
		if (campaignId === undefined) {
			campaignId = params.newId();
			created.push(campaignId);
		}
		used.add(campaignId);
		for (const member of members) membership.set(member, campaignId);
		for (const absorbed of previous) if (absorbed !== campaignId && !merged.has(absorbed)) merged.set(absorbed, campaignId);
	}
	// A campaign whose members are no longer confirmed sites keeps no members;
	// it is not merged anywhere and simply ends up empty.
	for (const [absorbed, into] of merged) {
		if ([...membership.values()].includes(absorbed)) merged.delete(absorbed);
		else merged.set(absorbed, into);
	}
	return { membership, merged, created };
}

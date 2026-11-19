import type { SiteCheck, SiteCheckState } from "./schema";

/** The part of a site's infrastructure that took it down. */
export type SiteCheckLayer = "registrar" | "host" | "cdn";

/** Which layer a state shows acting on the site; undefined while the site is up. */
export function siteCheckLayer(state: SiteCheckState): SiteCheckLayer | undefined {
	switch (state) {
		case "domain_gone":
		case "domain_suspended":
		case "parked":
			return "registrar";
		case "removed":
		case "host_suspended":
		case "unreachable":
			return "host";
		case "cdn_blocked":
			return "cdn";
		case "online":
		case "redirected":
			return undefined;
	}
}

/** The visit found the site gone. `unreachable` is down only when it repeats (see `takedownOf`). */
export function isDown(state: SiteCheckState): boolean {
	return siteCheckLayer(state) !== undefined;
}

/** The site answered: with its content, or by sending the visit elsewhere. */
export function isUp(state: SiteCheckState): boolean {
	return !isDown(state);
}

/** A first check this soon after the report dates a takedown it finds to within that time. */
const EXACT_FIRST_CHECK_MS = 2 * 60 * 60_000;

export type Takedown = {
	/** The first check after the report that found the site down. */
	downAt?: Date;
	/** The last check before `downAt` (or the latest one) that found it up; the report itself when none did, since the analysis saw it up then. */
	lastOnlineAt: Date;
	/** The layer that took the site down. */
	layer?: SiteCheckLayer;
	/** The latest check's state. */
	state?: SiteCheckState;
	/** The latest check found the site up, also after a takedown it came back from. */
	stillOnline: boolean;
	/**
	 * `downAt` is close to the takedown: a check after the report still found
	 * the site up, or the first check came within two hours of the report.
	 * Otherwise the takedown may have happened any time before `downAt`.
	 */
	exactTime: boolean;
};

/**
 * When and how one target's site went down, from its checks in ascending
 * order. Checks before the report are not about the reported site and are
 * ignored. A single `unreachable` is a server hiccup as often as a takedown,
 * so it counts only when the check after it also finds the site not up; its
 * layer is then the one the following checks name, when they name one.
 */
export function takedownOf(checks: readonly SiteCheck[], reportedAt: Date): Takedown {
	const relevant = checks.filter((check) => check.checkedAt.getTime() >= reportedAt.getTime());
	const latest = relevant.at(-1);
	const downIndex = relevant.findIndex((check, index) => {
		if (!isDown(check.state)) return false;
		if (check.state !== "unreachable") return true;
		const next = relevant[index + 1];
		return next !== undefined && !isUp(next.state);
	});
	const down = relevant[downIndex];
	const before = down ? relevant.slice(0, downIndex) : relevant;
	const lastOnline = before.findLast((check) => isUp(check.state));
	const base = {
		lastOnlineAt: lastOnline?.checkedAt ?? reportedAt,
		...(latest ? { state: latest.state } : {}),
		stillOnline: latest !== undefined && isUp(latest.state),
	};
	if (!down) return { ...base, exactTime: false };
	const first = relevant[0]!;
	return {
		...base,
		downAt: down.checkedAt,
		layer: takedownLayer(relevant.slice(downIndex)),
		exactTime: lastOnline !== undefined || first.checkedAt.getTime() - reportedAt.getTime() <= EXACT_FIRST_CHECK_MS,
	};
}

/** The layer of a down streak: the first state in it that names one more precisely than `unreachable`. */
function takedownLayer(streak: readonly SiteCheck[]): SiteCheckLayer | undefined {
	for (const check of streak) {
		if (isUp(check.state)) break;
		if (check.state !== "unreachable") return siteCheckLayer(check.state);
	}
	return siteCheckLayer(streak[0]!.state);
}

import { normalizeDomain } from "../security/security";
import type { FunnelPlatform } from "./platforms";
import { PLATFORM_NAMES } from "./platforms";

/**
 * The account a funnel report is about: the affiliate, at one business that
 * can terminate it (the merchant whose offer it promoted, or the operator of
 * a network tracking domain that paid it). It is the report's target, a
 * `service_account` like a Telegram bot, so the same affiliate at the same
 * business is one target across cases.
 */
export type FunnelPartyTarget = {
	role: "merchant" | "network";
	site: string;
	platform?: FunnelPlatform;
	affiliateId?: string;
};

const PREFIX = "affiliate";
const MAX_ID_LENGTH = 100;

/** `affiliate:<role>:<platform|->:<site>:<affiliate id|->`, the ID percent-encoded. */
export function funnelPartyTarget(party: FunnelPartyTarget): string {
	const id = party.affiliateId ? encodeURIComponent(party.affiliateId.slice(0, MAX_ID_LENGTH)) : "-";
	return [PREFIX, party.role, party.platform ?? "-", party.site, id].join(":");
}

export function parseFunnelPartyTarget(value: string): FunnelPartyTarget | undefined {
	const [prefix, role, platform, site, id, ...rest] = value.split(":");
	if (prefix !== PREFIX || rest.length || (role !== "merchant" && role !== "network") || !platform || !site || !id) return undefined;
	if (platform !== "-" && !Object.hasOwn(PLATFORM_NAMES, platform)) return undefined;
	if (normalizeDomain(site) !== site) return undefined;
	let affiliateId: string | undefined;
	try {
		affiliateId = id === "-" ? undefined : decodeURIComponent(id);
	} catch {
		return undefined;
	}
	return {
		role,
		site,
		...(platform !== "-" ? { platform: platform as FunnelPlatform } : {}),
		...(affiliateId ? { affiliateId } : {}),
	};
}

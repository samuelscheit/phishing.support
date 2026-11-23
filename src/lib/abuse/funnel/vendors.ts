import type { FunnelPlatform } from "./platforms";

/**
 * The company that sells a hosted tracking platform. A network's tracking
 * domain that publishes no contact is reported to the vendor, which knows
 * the customer behind the domain and can act under its own terms. Only
 * addresses the vendor itself publishes are listed, with where; a vendor
 * without one is no fallback (TUNE publishes only sales@tune.com,
 * tune.com/contact-us, checked 2026-11-23). Self-hosted trackers (Binom,
 * Keitaro) and the affiliate's own trackers have no vendor to ask.
 */
export type PlatformVendor = {
	name: string;
	domain: string;
	email: string;
	/** Where the vendor publishes `email`. */
	source: string;
};

export const FUNNEL_PLATFORM_VENDORS: Readonly<Partial<Record<FunnelPlatform, PlatformVendor>>> = {
	everflow: {
		name: "Everflow",
		domain: "everflow.io",
		email: "support@everflow.io",
		source: "Everflow's guide \"Starting an Affiliate Program\" (medium.com/everflow-blog): \"email our team at support@everflow.io\"",
	},
	cake: {
		name: "CAKE",
		domain: "getcake.com",
		email: "info@getcake.com",
		source: "the contact page getcake.com/contact (checked 2026-11-23)",
	},
};

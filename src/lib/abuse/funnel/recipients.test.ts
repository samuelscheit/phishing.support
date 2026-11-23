import { describe, expect, test } from "bun:test";

import { resolveAbuseTarget } from "../resolver";
import { contactPageLinks, htmlEmails, isPrivacyPlaceholder, mailboxRank, securityTxtEmails, whoisHolder } from "./contacts";
import { resolveFunnelPartyTarget, searchSiteContacts } from "./recipients";
import { funnelPartyTarget, parseFunnelPartyTarget } from "./target";
import { rdapDomain, web, ZATOS_HOME } from "./test_fixtures";

describe("mailbox ranking", () => {
	test("affiliate compliance before affiliates before abuse/legal before the support desk before anything else", () => {
		expect(["compliance@shopfixture.com", "affiliate-compliance@shopfixture.com", "fraud@shopfixture.com"].map(mailboxRank)).toEqual([0, 0, 0]);
		expect(["affiliates@shopfixture.com", "partners@shopfixture.com", "affiliate.program@shopfixture.com"].map(mailboxRank)).toEqual([1, 1, 1]);
		expect(["abuse@shopfixture.com", "legal@shopfixture.com", "security@shopfixture.com"].map(mailboxRank)).toEqual([2, 2, 2]);
		expect(["support@zatos.com", "info@shopfixture.com", "customer-service@shopfixture.com", "support+web@shopfixture.com"].map(mailboxRank)).toEqual([3, 3, 3, 3]);
		expect(mailboxRank("jane.doe@shopfixture.com")).toBe(4);
	});

	test("mailboxes that never act on a complaint, and artefacts that only look like mailboxes, are unsuitable", () => {
		for (const email of ["noreply@shopfixture.com", "no-reply@shopfixture.com", "privacy@getcake.com", "dpo@everflow.io", "sales@tune.com", "careers@shopfixture.com", "marketing@everflow.io", "zatoslogo-v1@2x.png", "a1b2c3d4e5f60718293a4b5c6d7e8f90@o12345.ingest.sentry.io", "you@example.com"]) {
			expect(mailboxRank(email)).toBeUndefined();
		}
	});
});

describe("page parsing", () => {
	test("security.txt contacts: mailto, bare addresses, several fields, URLs ignored", () => {
		expect(securityTxtEmails("# comment\nContact: mailto:security@shopfixture.com\ncontact: abuse@shopfixture.com\nContact: https://shopfixture.com/report\nExpires: 2027-01-01T00:00:00Z\n")).toEqual(["security@shopfixture.com", "abuse@shopfixture.com"]);
		expect(securityTxtEmails("Contact: mailto:sec%40shopfixture.com?subject=hi")).toEqual(["sec@shopfixture.com"]);
		expect(securityTxtEmails("<html>not found</html>")).toEqual([]);
	});

	test("mailto links, Cloudflare-protected addresses, [at]/[dot] spellings and plain text, with entities decoded", () => {
		const key = 0x42;
		const cf = key.toString(16) + [..."affiliates@shopfixture.com"].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
		const html = `
			<a href="mailto:Support@Zatos.com?subject=Help">Mail us</a>
			<span class="__cf_email__" data-cfemail="${cf}">[email&#160;protected]</span>
			<p>Partners: compliance [at] shopfixture [dot] com</p>
			<p>Or write to legal&#64;shopfixture.com.</p>
			<img src="/img/zatosLogo-v1@2x.png">`;
		expect(htmlEmails(html)).toEqual(["support@zatos.com", "affiliates@shopfixture.com", "compliance@shopfixture.com", "legal@shopfixture.com", "zatoslogo-v1@2x.png"]);
	});

	test("contact page links: the site's own (subdomains too), affiliate and contact pages first, no mailto/javascript/foreign links", () => {
		const html = `
			<a href="https://help.zatos.com/privacy/index-antivirus.php">Privacy</a>
			<a href="https://help.zatos.com/terms/index-antivirus.php">Terms</a>
			<a href="/contact-us#form">Contact <b>us</b></a>
			<a href='/affiliate-program'>Become a partner</a>
			<a href="https://twitter.com/zatos">Contact on Twitter</a>
			<a href="mailto:support@zatos.com">support</a>
			<a href="javascript:void(0)">Help</a>
			<a href="/pricing">Pricing</a>`;
		expect(contactPageLinks(html, new URL("https://www.zatos.com/"), "zatos.com")).toEqual([
			"https://www.zatos.com/affiliate-program",
			"https://www.zatos.com/contact-us",
			"https://help.zatos.com/terms/index-antivirus.php",
			"https://help.zatos.com/privacy/index-antivirus.php",
		]);
	});

	test("privacy placeholders: privacy services by mailbox or name, and forwarding mailboxes at the registrar", () => {
		expect(isPrivacyPlaceholder({ email: "2f0c1b@withheldforprivacy.com" })).toBeTrue();
		expect(isPrivacyPlaceholder({ email: "shopfixture.com@domainsbyproxy.com" })).toBeTrue();
		expect(isPrivacyPlaceholder({ organization: "Privacy service provided by Withheld for Privacy ehf" })).toBeTrue();
		expect(isPrivacyPlaceholder({ name: "REDACTED FOR PRIVACY" })).toBeTrue();
		expect(isPrivacyPlaceholder({ email: "abc123@contact.gandi.net" }, ["gandi.net"])).toBeTrue();
		expect(isPrivacyPlaceholder({ email: "owner@shopfixture.com", organization: "Shop Example GmbH" }, ["gandi.net"])).toBeFalse();
	});

	test("port-43 WHOIS holder: registrant and admin mailboxes and organization, never the technical contact", () => {
		const raw = "Registrant Name: Redacted for Privacy Purposes\nRegistrant Organization: Privacy service provided by WITHHELD FOR PRIVACY LLC\nRegistrant Email: a1b2@withheldforprivacy.com\nAdmin Email: owner@shopfixture.com\nTech Contact Email: hostmaster@hosterfixture.de\nTech Email: support@hosterfixture.de\n";
		expect(whoisHolder(raw)).toEqual({ emails: ["a1b2@withheldforprivacy.com", "owner@shopfixture.com"], organization: "Privacy service provided by WITHHELD FOR PRIVACY LLC", name: "Redacted for Privacy Purposes" });
	});
});

describe("funnel party targets", () => {
	test("round-trip every role, platform and an affiliate ID with separators", () => {
		for (const party of [
			{ role: "merchant" as const, site: "zatos.com", affiliateId: "15065" },
			{ role: "network" as const, site: "miamitrk.com", platform: "cake" as const, affiliateId: "15065" },
			{ role: "network" as const, site: "onlinesafetyall.com", platform: "everflow" as const, affiliateId: "a:b/c d" },
			{ role: "merchant" as const, site: "shopfixture.com" },
		]) {
			expect(parseFunnelPartyTarget(funnelPartyTarget(party))).toEqual(party);
		}
		expect(funnelPartyTarget({ role: "network", site: "miamitrk.com", platform: "cake", affiliateId: "15065" })).toBe("affiliate:network:cake:miamitrk.com:15065");
	});

	test("anything else is no funnel party", () => {
		for (const value of ["telegram-bot:123", "affiliate:buyer:-:shopfixture.com:1", "affiliate:merchant:acme:shopfixture.com:1", "affiliate:merchant:-:ShopFixture.com:1", "affiliate:merchant:-:shopfixture.com", "affiliate:merchant:-:shopfixture.com:%E0%A4%A"]) {
			expect(parseFunnelPartyTarget(value)).toBeUndefined();
		}
	});
});


describe("searchSiteContacts", () => {
	test("Zatos as it is: no security.txt, a private registration, support@ published on its linked help pages", async () => {
		const deps = web({
			"https://zatos.com/": { status: 301, location: "https://www.zatos.com/" },
			"https://www.zatos.com/": { body: ZATOS_HOME },
			"https://help.zatos.com/terms/index-antivirus.php": { body: "<p>Questions? Email support@zatos.com</p>" },
			"https://help.zatos.com/knowledgebase/index-antivirus.php": { body: "<a href='mailto:support@zatos.com'>support@zatos.com</a>" },
			"https://rdap.test/domain/zatos.com": rdapDomain("zatos.com", { email: "c5e0@withheldforprivacy.com", org: "Privacy service provided by Withheld for Privacy ehf", name: "Redacted for Privacy" }),
		});
		const search = await searchSiteContacts("zatos.com", deps);
		expect(search.contacts).toEqual([{ email: "support@zatos.com", source: "funnel_website", foundAt: "https://help.zatos.com/knowledgebase/index-antivirus.php", rank: 3 }]);
		expect(search.redacted).toBeTrue();
		expect(search.holder).toBeUndefined();
		expect(search.failures).toEqual([]);
		expect(deps.requested).toContain("https://zatos.com/.well-known/security.txt");
		expect(deps.requested).toContain("https://help.zatos.com/terms/index-antivirus.php");
	});

	test("security.txt and an affiliate page outrank the support desk; a non-redacted registrant is a further contact", async () => {
		const deps = web({
			"https://shopfixture.com/.well-known/security.txt": { type: "text/plain", body: "Contact: mailto:security@shopfixture.com\n" },
			"https://shopfixture.com/": { body: `<a href="/partners">Affiliate program</a><a href="mailto:help@shopfixture.com">help</a>` },
			"https://shopfixture.com/partners": { body: `<p>Affiliate compliance: <a href="mailto:affiliate-compliance@shopfixture.com">write us</a></p>` },
			"https://rdap.test/domain/shopfixture.com": rdapDomain("shopfixture.com", { email: "owner@shopfixture.com", org: "Shop Example GmbH" }),
		});
		const search = await searchSiteContacts("shopfixture.com", deps);
		expect(search.contacts.map(({ email, source }) => [email, source])).toEqual([
			["affiliate-compliance@shopfixture.com", "funnel_website"],
			["security@shopfixture.com", "funnel_security_txt"],
			["help@shopfixture.com", "funnel_website"],
			["owner@shopfixture.com", "funnel_holder_rdap"],
		]);
		expect(search.holder).toBe("Shop Example GmbH");
		expect(search.redacted).toBeFalse();
	});

	test("pages and security.txt count only with the business's own mailboxes: a linked agency, the FTC or a bug bounty platform are never recipients", async () => {
		const deps = web({
			"https://shopfixture.com/.well-known/security.txt": { type: "text/plain", body: "Contact: mailto:shopfixture@bugbountyfixture.com\n" },
			"https://shopfixture.com/": { body: `<a href="mailto:compliance@agencyfixture.com">Site by Agency</a> <a href="/terms">Terms</a> <a href="mailto:info@shopfixture.com">Info</a>` },
			"https://shopfixture.com/terms": { body: `Report fraud to the FTC: <a href="mailto:reportfraud@ftc.gov">reportfraud@ftc.gov</a>` },
		});
		expect((await searchSiteContacts("shopfixture.com", deps)).contacts.map(({ email }) => email)).toEqual(["info@shopfixture.com"]);
	});

	test("the domain's technical contact (its host or reseller) is no recipient, and an own-domain mailbox beats an abuse desk elsewhere", async () => {
		const technicalOnly = web({
			"https://rdap.test/domain/shopfixture.com": { body: JSON.stringify({ entities: [{ roles: ["technical"], vcardArray: ["vcard", [["email", {}, "text", "abuse@hosterfixture.de"]]] }] }) },
		});
		expect((await searchSiteContacts("shopfixture.com", technicalOnly)).contacts).toEqual([]);
		const both = web({
			"https://shopfixture.com/": { body: `<a href="mailto:info@shopfixture.com">Info</a>` },
			"https://rdap.test/domain/shopfixture.com": rdapDomain("shopfixture.com", { email: "abuse@ownerfixture.de", org: "Shop Fixture GmbH" }),
		});
		expect((await searchSiteContacts("shopfixture.com", both)).contacts.map(({ email, source }) => [email, source])).toEqual([
			["info@shopfixture.com", "funnel_website"],
			["abuse@ownerfixture.de", "funnel_holder_rdap"],
		]);
	});

	test("a platform tenant is searched on its own host only: never the platform's registration or security.txt", async () => {
		const deps = web({
			"https://store1.myshopify.com/": { body: `<a href="mailto:support@shopify.com">Shopify</a> <a href="mailto:hello@store1fixture.com">Write us</a>` },
			"https://rdap.test/domain/myshopify.com": rdapDomain("myshopify.com", { email: "domains@shopify.com", org: "Shopify Inc." }),
		});
		const search = await searchSiteContacts("store1.myshopify.com", deps);
		expect(search.contacts).toEqual([]);
		expect(deps.requested).toEqual(expect.not.arrayContaining(["https://store1.myshopify.com/.well-known/security.txt", "https://rdap.test/domain/myshopify.com", "https://rdap.test/domain/store1.myshopify.com", "https://www.store1.myshopify.com/"]));
	});

	test("a soft-404 security.txt, foreign addresses in text, a page that moved to another site and a registrar forwarding mailbox are all ignored", async () => {
		const deps = web({
			"https://shopfixture.com/.well-known/security.txt": { body: "<html><body>Contact: mailto:fake@shopfixture.com</body></html>" },
			"https://shopfixture.com/": { body: `<p>Powered by builder; contact hello@builderfixture.com</p><a href="/contact">Contact</a>` },
			"https://shopfixture.com/contact": { status: 302, location: "https://parkedfixture.com/contact" },
			"https://parkedfixture.com/contact": { body: "<a href='mailto:sales@parkedfixture.com'>buy this domain</a> info@parkedfixture.com" },
			"https://rdap.test/domain/shopfixture.com": rdapDomain("shopfixture.com", { email: "shopfixture.com@contact.namecheap.com", org: "Shop Example" }),
		});
		const search = await searchSiteContacts("shopfixture.com", deps);
		expect(search.contacts).toEqual([]);
		expect(search.redacted).toBeTrue();
		expect(search.holder).toBe("Shop Example");
	});

	test("port-43 WHOIS when RDAP names no holder; a redacted WHOIS gives nothing, an open one gives the registrant", async () => {
		const redacted = web({ "https://rdap.test/domain/shopfixture.com": { body: JSON.stringify({ port43: "whois.registrarfixture.com", entities: [] }) } }, {
			port43Query: async () => "Registrant Organization: REDACTED FOR PRIVACY\nRegistrant Email: Please query the RDDS service of the Registrar of Record\n",
		});
		expect((await searchSiteContacts("shopfixture.com", redacted)).contacts).toEqual([]);
		const open = web({ "https://rdap.test/domain/shopfixture.com": { body: JSON.stringify({ port43: "whois.registrarfixture.com", entities: [] }) } }, {
			port43Query: async (server, query) => server === "whois.registrarfixture.com" && query === "shopfixture.com" ? "Registrant Organization: Shop Example Ltd\nRegistrant Email: legal@shopfixture.com\n" : "",
		});
		const search = await searchSiteContacts("shopfixture.com", open);
		expect(search.contacts).toEqual([{ email: "legal@shopfixture.com", source: "funnel_holder_whois", foundAt: "WHOIS whois.registrarfixture.com", rank: 2 }]);
		expect(search.holder).toBe("Shop Example Ltd");
	});

	test("timeouts and server errors are failures worth a retry; a missing site is not", async () => {
		const deps = web({
			"https://shopfixture.com/": new Error("The operation timed out."),
			"https://www.shopfixture.com/": { status: 503 },
			"https://rdap.test/domain/shopfixture.com": { status: 500 },
		});
		const search = await searchSiteContacts("shopfixture.com", deps);
		expect(search.contacts).toEqual([]);
		expect(search.failures).toEqual(expect.arrayContaining([
			expect.stringContaining("https://shopfixture.com/: "),
			"https://www.shopfixture.com/: HTTP 503",
			expect.stringContaining("RDAP domain shopfixture.com"),
		]));
		const gone = await searchSiteContacts("gonefixture.com", web({}, {
			assertPublicHost: async (host) => {
				if (host.endsWith("gonefixture.com")) throw new Error("The destination hostname is not a public DNS name.");
			},
		}));
		expect(gone.failures).toEqual([]);
	});

	test("every page goes through the public-host guard", async () => {
		const guarded: string[] = [];
		const deps = web({ "https://shopfixture.com/": { status: 302, location: "http://127.0.0.1/admin" } }, {
			assertPublicHost: async (host) => {
				guarded.push(host);
				if (host === "127.0.0.1") throw new Error("The destination resolves to a non-public network address.");
			},
		});
		await searchSiteContacts("shopfixture.com", deps);
		expect(guarded).toContain("127.0.0.1");
		expect(deps.requested).not.toContain("http://127.0.0.1/admin");
	});
});

describe("resolveFunnelPartyTarget", () => {
	const target = (normalizedTarget: string) => ({ normalizedTarget, targetType: "service_account" as const, observedUrls: [] });

	test("a merchant's best mailbox, its others as fallbacks, through resolveAbuseTarget", async () => {
		const deps = web({
			"https://shopfixture.com/": { body: `<a href="mailto:affiliates@shopfixture.com">a</a><a href="mailto:support@shopfixture.com">s</a>` },
		});
		const resolved = await resolveAbuseTarget(target("affiliate:merchant:-:shopfixture.com:777"), deps);
		expect(resolved.status).toBe("resolved");
		expect(resolved.routes).toEqual([expect.objectContaining({
			routeKey: "email:affiliates@shopfixture.com",
			routeType: "email",
			verifiedEmail: "affiliates@shopfixture.com",
			providerDisplayName: "shopfixture.com",
			status: "verified",
			resolverProvenance: {
				email: "affiliates@shopfixture.com",
				source: "funnel_website",
				organization: "shopfixture.com",
				foundAt: "https://shopfixture.com/",
				fallbackContacts: [{ email: "support@shopfixture.com", source: "funnel_website", organization: "shopfixture.com", foundAt: "https://shopfixture.com/" }],
			},
		})]);
		expect(resolved.resolverSnapshot).toMatchObject({ funnelParty: { role: "merchant", site: "shopfixture.com", affiliateId: "777" } });
	});

	test("a merchant without any contact has no route, and is not retried", async () => {
		const resolved = await resolveFunnelPartyTarget(target("affiliate:merchant:-:shopfixture.com:777"), web({ "https://rdap.test/domain/shopfixture.com": rdapDomain("shopfixture.com", { email: "x@withheldforprivacy.com" }) }));
		expect(resolved).toMatchObject({ status: "no_route", disposition: "no_merchant_contact", routes: [{ routeType: "manual_unroutable", status: "no_route" }] });
		expect(resolved.lookupFailures).toBeUndefined();
	});

	test("a CAKE network that publishes nothing (miamitrk.com) is reported to CAKE as its platform", async () => {
		const deps = web({
			"https://miamitrk.com/": { body: "<html></html>" },
			"https://rdap.test/domain/miamitrk.com": rdapDomain("miamitrk.com", { email: "c1@withheldforprivacy.com", org: "Privacy service provided by Withheld for Privacy ehf" }),
		});
		const resolved = await resolveFunnelPartyTarget(target("affiliate:network:cake:miamitrk.com:15065"), deps);
		expect(resolved.routes[0]).toMatchObject({ verifiedEmail: "info@getcake.com", providerDisplayName: "CAKE", resolverProvenance: { source: "funnel_platform_vendor", organization: "CAKE" } });
		expect(resolved.resolverSnapshot).toMatchObject({ platformVendor: { name: "CAKE", domain: "getcake.com" }, contactSearch: { redacted: true } });
		expect(deps.requested.some((url) => url.includes("getcake.com"))).toBeFalse();
	});

	test("a network with its own contact keeps the platform vendor as the last fallback", async () => {
		const deps = web({ "https://onlinesafetyall.com/": { body: `<a href="mailto:compliance@onlinesafetyall.com">compliance</a>` } });
		const resolved = await resolveFunnelPartyTarget(target("affiliate:network:everflow:onlinesafetyall.com:6RNXHT"), deps);
		expect(resolved.routes[0]).toMatchObject({
			verifiedEmail: "compliance@onlinesafetyall.com",
			resolverProvenance: { source: "funnel_website", fallbackContacts: [{ email: "support@everflow.io", source: "funnel_platform_vendor", organization: "Everflow" }] },
		});
	});

	test("a vendor without a published address is no fallback, and its site is never searched", async () => {
		const deps = web({ "https://tune.com/": { body: `<a href="mailto:compliance@tune.com">Compliance</a>` } });
		const resolved = await resolveFunnelPartyTarget(target("affiliate:network:tune:go2cloudfixture.com:2002"), deps);
		expect(resolved).toMatchObject({ status: "no_route", disposition: "no_network_contact" });
		expect(deps.requested.some((url) => url.includes("tune.com"))).toBeFalse();
	});

	test("a network whose platform was only guessed (no platform in its target) has no vendor to fall back to", async () => {
		const resolved = await resolveFunnelPartyTarget(target("affiliate:network:-:miamitrk.com:15065"), web({}));
		expect(resolved).toMatchObject({ status: "no_route", disposition: "no_network_contact" });
		expect(parseFunnelPartyTarget("affiliate:network:affiliate_link:partnersfixture.com:A-77")).toBeUndefined();
	});

	test("a stand-in recipient while a lookup failed is resolved again before anything is sent", async () => {
		// The network's own site timed out: the vendor is the route, but the worker resolves again first.
		const network = await resolveFunnelPartyTarget(target("affiliate:network:cake:miamitrk.com:15065"), web({ "https://miamitrk.com/": new Error("ETIMEDOUT"), "https://www.miamitrk.com/": new Error("ETIMEDOUT") }));
		expect(network.routes[0]).toMatchObject({ verifiedEmail: "info@getcake.com" });
		expect(network.lookupFailures).toEqual(expect.arrayContaining([expect.stringContaining("https://miamitrk.com/")]));
		// The merchant's home page timed out: the registrant's mailbox at another domain waits as well.
		const merchant = await resolveFunnelPartyTarget(target("affiliate:merchant:-:shopfixture.com:1"), web({
			"https://shopfixture.com/": new Error("socket hang up"),
			"https://www.shopfixture.com/": new Error("socket hang up"),
			"https://rdap.test/domain/shopfixture.com": rdapDomain("shopfixture.com", { email: "owner@gmail.com", org: "Shop Fixture GmbH" }),
		}));
		expect(merchant.routes[0]).toMatchObject({ verifiedEmail: "owner@gmail.com" });
		expect(merchant.lookupFailures?.length).toBeGreaterThan(0);
		// The business's own mailbox is sent at once, whatever else timed out.
		const own = await resolveFunnelPartyTarget(target("affiliate:merchant:-:shopfixture.com:1"), web({
			"https://shopfixture.com/": { body: `<a href="mailto:info@shopfixture.com">Info</a>` },
			"https://shopfixture.com/contact": new Error("ETIMEDOUT"),
		}));
		expect(own.routes[0]).toMatchObject({ verifiedEmail: "info@shopfixture.com" });
		expect(own.lookupFailures).toBeUndefined();
	});

	test("failed lookups without any contact are a failed resolution the worker repeats", async () => {
		const resolved = await resolveFunnelPartyTarget(target("affiliate:merchant:-:shopfixture.com:1"), web({ "https://shopfixture.com/": new Error("socket hang up"), "https://www.shopfixture.com/": new Error("ETIMEDOUT") }));
		expect(resolved).toMatchObject({ status: "failed", disposition: "funnel_contact_lookup_failed", routes: [{ status: "failed" }] });
		expect(resolved.lookupFailures?.length).toBeGreaterThan(0);
	});
});

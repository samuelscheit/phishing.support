import { describe, expect, test } from "bun:test";

import { organisationOf, slugify } from "./organisation";
import { roleOf } from "./role";

const mail = (email: string, providerDisplayName = "Abuse-C Role") => ({ providerRegistryKey: `email:${email.split("@")[1]}`, providerDisplayName, verifiedEmail: email });
const integration = (providerRegistryKey: string, providerDisplayName = "Provider") => ({ providerRegistryKey, providerDisplayName, verifiedEmail: null });

describe("organisationOf", () => {
	test("groups every channel of one company: direct integration, historical record and abuse mailbox", () => {
		expect(organisationOf(integration("cloudflare", "Cloudflare Abuse"))).toEqual({ slug: "cloudflare", name: "Cloudflare", role: "cdn" });
		expect(organisationOf(integration("historical:cloudflare_abuse"))).toMatchObject({ slug: "cloudflare" });
		expect(organisationOf(mail("registrar-abuse@cloudflare.com", "Cloudflare, Inc."))).toMatchObject({ slug: "cloudflare" });
		expect(organisationOf(integration("netcraft_mail"))).toMatchObject({ slug: "netcraft", role: "blocklist" });
		expect(organisationOf(integration("historical:google_safe_browsing"))).toMatchObject({ slug: "google-safe-browsing" });
	});

	test("a mailbox on a subdomain or a sister domain belongs to the registrable domain's company", () => {
		expect(organisationOf(mail("domainabuse@service.aliyun.com"))).toMatchObject({ slug: "alibaba-cloud", name: "Alibaba Cloud" });
		expect(organisationOf(mail("trustandsafety@support.aws.com"))).toMatchObject({ slug: "amazon" });
		expect(organisationOf(mail("email-abuse@amazon.com", "Amazon SES Abuse"))).toMatchObject({ slug: "amazon" });
		expect(organisationOf(mail("abuse@namecheaphosting.com"))).toMatchObject({ slug: "namecheap" });
		expect(organisationOf(mail("abuse@bluehost.com", "Abuse contact for oxwitik.com"))).toMatchObject({ slug: "newfold-digital" });
		expect(organisationOf(mail("abuse@enom.com"))).toMatchObject({ slug: "tucows" });
		expect(organisationOf(mail("abuse@registrar.eu"))).toMatchObject({ slug: "openprovider", role: "registrar" });
	});

	test("mailbox domains are compared without case", () => {
		expect(organisationOf(mail("ZYS@GNAME.COM", "ZYS@GNAME.COM"))).toMatchObject({ slug: "gname", name: "Gname" });
		expect(organisationOf({ providerRegistryKey: "email:Newfold.com", providerDisplayName: "IARPOC@Newfold.com", verifiedEmail: "IARPOC@Newfold.com" })).toMatchObject({ slug: "newfold-digital" });
	});

	test("an unknown company is named after its mailbox domain, never after a generic RDAP role name", () => {
		expect(organisationOf(mail("abuse@packethub.tech", "Abuse-C Role"))).toEqual({ slug: "packethub-tech", name: "packethub.tech" });
		expect(organisationOf(mail("abuse@corelux.com.tr"))).toEqual({ slug: "corelux-com-tr", name: "corelux.com.tr" });
	});

	test("a free-mail address is its own organisation, not the mail service's company", () => {
		expect(organisationOf(mail("olatunji8221@gmail.com"))).toEqual({ slug: "olatunji8221-gmail-com", name: "olatunji8221@gmail.com" });
		expect(organisationOf(mail("someone@qq.com")).slug).not.toBe(organisationOf(mail("other@qq.com")).slug);
	});

	test("an origin-host mail route without a domain in its key is grouped by its mailbox", () => {
		expect(organisationOf({ providerRegistryKey: "origin-host-email", providerDisplayName: "Informaten (origin host of herstel-google.com)", verifiedEmail: "abuse@informaten.com" })).toEqual({ slug: "informaten-com", name: "informaten.com" });
	});

	test("each authority is its own organisation under its own name", () => {
		expect(organisationOf({ providerRegistryKey: "authority:by-zcb", providerDisplayName: "Zentralstelle Cybercrime Bayern", verifiedEmail: "zcb@polizei.bayern.de" })).toEqual({ slug: "authority-by-zcb", name: "Zentralstelle Cybercrime Bayern" });
	});

	test("an integration without a known company keeps its key", () => {
		expect(organisationOf(integration("some_new_provider", "Some New Provider"))).toEqual({ slug: "some-new-provider", name: "Some New Provider" });
	});

	test("slugify keeps only lower-case words joined by single hyphens", () => {
		expect(slugify("  Foo__Bar.com  ")).toBe("foo-bar-com");
		expect(slugify("@@@")).toBe("unknown");
	});
});

describe("roleOf", () => {
	const route = (source: string | undefined, providerRegistryKey = "email:example.com") => ({ providerRegistryKey, resolverProvenance: source ? { source } : {} });
	const unknown = { slug: "example-com", name: "example.com" };

	test("the resolver's provenance names the role", () => {
		expect(roleOf(route("registrar_rdap"), "domain", unknown)).toBe("registrar");
		expect(roleOf(route("domain_rdap"), "domain", unknown)).toBe("registrar");
		expect(roleOf(route("domain_whois"), "domain", unknown)).toBe("registrar");
		expect(roleOf(route("domain_infrastructure_ip"), "domain", unknown)).toBe("host");
		expect(roleOf(route("ip_rdap"), "ip", unknown)).toBe("host");
		expect(roleOf(route("ripe_abuse_c"), "ip", unknown)).toBe("host");
		expect(roleOf(route("cloudflare_origin_disclosure"), "domain", unknown)).toBe("host");
		expect(roleOf(route("service_account_registry"), "service_account", unknown)).toBe("platform");
		expect(roleOf(route("authority_registry"), "campaign", unknown)).toBe("authority");
	});

	test("a CDN reached through the site's addresses is the CDN, but the same company as registrar stays registrar", () => {
		const cloudflare = organisationOf(integration("cloudflare"));
		expect(roleOf(route("domain_infrastructure_ip", "cloudflare"), "domain", cloudflare)).toBe("cdn");
		expect(roleOf(route("registrar_rdap"), "domain", cloudflare)).toBe("registrar");
		// The origin Cloudflare disclosed is a real host, even when it sits at a CDN company.
		expect(roleOf(route("cloudflare_origin_disclosure"), "domain", cloudflare)).toBe("host");
	});

	test("a blocklist is a blocklist whatever led to it", () => {
		const netcraft = organisationOf(integration("netcraft"));
		expect(roleOf(route("provider_supplemental_target_rule", "netcraft"), "domain", netcraft)).toBe("blocklist");
		expect(roleOf(route("migrated_legacy_provider_report", "historical:google_safe_browsing"), "domain", organisationOf(integration("historical:google_safe_browsing")))).toBe("blocklist");
	});

	test("without provenance the target decides, then the company's known role", () => {
		const legacy = route("migrated_legacy_provider_report");
		expect(roleOf(legacy, "email", unknown)).toBe("email");
		expect(roleOf(legacy, "ip", unknown)).toBe("host");
		expect(roleOf(legacy, "service_account", unknown)).toBe("platform");
		expect(roleOf(legacy, "campaign", unknown)).toBe("authority");
		expect(roleOf(legacy, "domain", organisationOf(mail("ZYS@GNAME.COM")))).toBe("registrar");
		expect(roleOf(legacy, "domain", organisationOf(mail("google-cloud-compliance@google.com")))).toBe("host");
		expect(roleOf(legacy, "domain", unknown)).toBe("other");
		expect(roleOf(route(undefined, "authority:by-zac"), "campaign", unknown)).toBe("authority");
	});
});

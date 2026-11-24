import { describe, expect, test } from "bun:test";

import { hostRegistration, siteOf } from "./registered_domain";

describe("siteOf", () => {
	test("hosts of one registered domain are one site, each platform tenant a site of its own", () => {
		expect(siteOf("login.Example.com.")).toEqual({ site: "example.com" });
		expect(siteOf("trustwallet.com-info.vip")).toEqual({ site: "com-info.vip" });
		expect(siteOf("kit.pages.dev")).toEqual({ site: "kit.pages.dev", platform: "pages.dev" });
		expect(siteOf("a.kit.pages.dev").site).not.toBe(siteOf("other.pages.dev").site);
		expect(siteOf("203.0.113.7")).toEqual({ site: "203.0.113.7" });
		expect(siteOf("localhost")).toEqual({ site: "localhost" });
	});
});

describe("hostRegistration", () => {
	test("a host is looked up by the domain its registry holds", () => {
		expect(hostRegistration("trustwallet.com-info.vip")).toEqual({ domain: "com-info.vip" });
		expect(hostRegistration("eu-north-1.signin.aws.kippertranslation.com")).toEqual({ domain: "kippertranslation.com" });
		expect(hostRegistration("pay.bdpay.com.bd")).toEqual({ domain: "bdpay.com.bd" });
		expect(hostRegistration("Example.COM.")).toEqual({ domain: "example.com" });
	});

	test("platform tenants are told from a brand's own hosts", () => {
		expect(hostRegistration("x.blogspot.com")).toEqual({ platformTenant: "x.blogspot.com" });
		expect(hostRegistration("KIT.web.app.")).toEqual({ platformTenant: "kit.web.app" });
		expect(hostRegistration("deep.kit.github.io")).toEqual({ platformTenant: "kit.github.io" });
		expect(hostRegistration("bucket.s3.amazonaws.com")).toEqual({ platformTenant: "bucket.s3.amazonaws.com" });
		expect(hostRegistration("sites.google.com")).toEqual({ platformTenant: "sites.google.com" });
		expect(hostRegistration("signin.amazonaws-us-gov.com")).toEqual({ domain: "amazonaws-us-gov.com" });
		expect(hostRegistration("forms.office.com")).toEqual({ domain: "office.com" });
		expect(hostRegistration("www.youtube.com")).toEqual({ domain: "youtube.com" });
	});

	test("an IP or a bare public suffix has no registration", () => {
		expect(hostRegistration("203.0.113.7")).toBeUndefined();
		expect(hostRegistration("2001:db8::1")).toBeUndefined();
		expect(hostRegistration("co.uk")).toBeUndefined();
	});
});

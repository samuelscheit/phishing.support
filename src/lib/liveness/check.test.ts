import { describe, expect, test } from "bun:test";

import { AbuseInputError } from "../abuse/security";
import { checkSite, type SiteCheckDependencies, type SiteDnsResolver } from "./check";

const NOW = new Date("2026-11-19T10:00:00.000Z");
const SITE = "https://login.kit-example.com/verify";

function dnsError(code: string): Error {
	return Object.assign(new Error(`query ${code} login.kit-example.com`), { code });
}

function resolver(answers: { a?: string[] | string; aaaa?: string[] | string; cname?: string[] | string } = {}): SiteDnsResolver & { calls: string[] } {
	const calls: string[] = [];
	const answer = (type: string, value: string[] | string | undefined) => async (host: string) => {
		calls.push(`${type} ${host}`);
		if (value === undefined) throw dnsError("ENODATA");
		if (typeof value === "string") throw dnsError(value);
		return value;
	};
	return { calls, resolve4: answer("A", answers.a), resolve6: answer("AAAA", answers.aaaa), resolveCname: answer("CNAME", answers.cname) };
}

type Route = { status: number; body?: string; headers?: Record<string, string> } | Error;

/** A fetch answering by URL; it records each request and the headers it carried. */
function site(routes: Record<string, Route>) {
	const requests: Array<{ url: string; headers: Record<string, string>; redirect?: RequestRedirect }> = [];
	const fetch = async (input: string | URL, init?: RequestInit) => {
		const url = input.toString();
		requests.push({ url, headers: { ...(init?.headers as Record<string, string>) }, ...(init?.redirect ? { redirect: init.redirect } : {}) });
		const route = routes[url];
		if (!route) throw new Error(`Unexpected request to ${url}`);
		if (route instanceof Error) throw route;
		return new Response(route.body ?? "", { status: route.status, headers: { "content-type": "text/html; charset=utf-8", ...route.headers } });
	};
	return { fetch, requests };
}

/** RDAP answering one status list for every domain, and recording the domains asked. */
function rdap(statuses: string[] | Error) {
	const asked: string[] = [];
	return {
		asked,
		dependencies: {
			rdapLocator: async (_object: string, value: string) => `https://rdap.registry.example/domain/${value}`,
			assertPublicHost: async () => undefined,
			httpRetryAttempts: 1,
			fetch: async (input: RequestInfo | URL) => {
				asked.push(new URL(input.toString()).pathname.split("/").at(-1)!);
				if (statuses instanceof Error) throw statuses;
				return new Response(JSON.stringify({ objectClassName: "domain", ldhName: "kit-example.com", status: statuses }), { status: 200, headers: { "content-type": "application/rdap+json" } });
			},
		},
	};
}

function dependencies(overrides: Partial<SiteCheckDependencies> = {}): SiteCheckDependencies {
	return {
		dns: resolver({ a: ["203.0.113.10"] }),
		rdap: rdap(["client transfer prohibited"]).dependencies,
		assertPublicHost: async () => undefined,
		now: () => NOW,
		...overrides,
	};
}

const KIT = `<html><head><title>Sign in</title></head><body><form><input type="password" name="p"></form></body></html>`;

describe("checkSite", () => {
	test("visits the site like a desktop browser and records what answered", async () => {
		const { fetch, requests } = site({ [SITE]: { status: 200, body: KIT } });
		const dns = resolver({ a: ["203.0.113.10", "203.0.113.11"], aaaa: ["2001:db8::10"] });
		expect(await checkSite(SITE, dependencies({ fetch, dns }))).toEqual({
			url: SITE,
			state: "online",
			detail: "HTTP 200.",
			httpStatus: 200,
			finalUrl: SITE,
			resolvedAddresses: ["203.0.113.10", "203.0.113.11", "2001:db8::10"],
			domainStatuses: ["client transfer prohibited"],
			checkedAt: NOW,
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]!.redirect).toBe("manual");
		expect(requests[0]!.headers["user-agent"]).toMatch(/^Mozilla\/5\.0 \(Macintosh;.*Chrome\/\d+/);
		expect(requests[0]!.headers.accept).toContain("text/html");
		expect(requests[0]!.headers["accept-language"]).toContain("en-US");
	});

	test("NXDOMAIN ends the check without a visit", async () => {
		const { fetch, requests } = site({});
		const dns = resolver({ a: "ENOTFOUND", aaaa: "ENOTFOUND", cname: "ENOTFOUND" });
		expect(await checkSite(SITE, dependencies({ fetch, dns }))).toMatchObject({ state: "domain_gone", detail: "login.kit-example.com no longer resolves (NXDOMAIN).", httpStatus: null, finalUrl: null, resolvedAddresses: [] });
		expect(requests).toHaveLength(0);
		// NXDOMAIN is an answer; it is not asked again.
		expect(dns.calls.filter((call) => call.startsWith("A "))).toHaveLength(1);
	});

	test("NXDOMAIN behind an existing CNAME is the site's host removing it", async () => {
		const dns = resolver({ a: "ENOTFOUND", aaaa: "ENOTFOUND", cname: ["kit-example.netlify.app"] });
		expect(await checkSite(SITE, dependencies({ fetch: site({}).fetch, dns }))).toMatchObject({ state: "removed", detail: "The site's CNAME target kit-example.netlify.app no longer exists (NXDOMAIN)." });
	});

	test("a resolver failure is not NXDOMAIN: the visit decides", async () => {
		const refused = Object.assign(new TypeError("ECONNREFUSED: Unable to connect. Is the computer able to access the url?"), { code: "ECONNREFUSED" });
		const { fetch, requests } = site({ [SITE]: refused });
		const dns = resolver({ a: "ESERVFAIL", aaaa: "ESERVFAIL" });
		expect(await checkSite(SITE, dependencies({ fetch, dns }))).toMatchObject({ state: "unreachable", detail: "No answer: ECONNREFUSED: Unable to connect. Is the computer able to access the url?", httpStatus: null, finalUrl: SITE });
		expect(requests).toHaveLength(1);
		// SERVFAIL may pass; it is asked twice.
		expect(dns.calls.filter((call) => call.startsWith("A "))).toHaveLength(2);
	});

	test("TLS failures and timeouts are unreachable with their cause", async () => {
		const expired = Object.assign(new TypeError("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
		expect(await checkSite(SITE, dependencies({ fetch: site({ [SITE]: expired }).fetch }))).toMatchObject({ state: "unreachable", detail: "No answer: CERT_HAS_EXPIRED: certificate has expired" });
		const timeout = new DOMException("The operation timed out.", "TimeoutError");
		expect(await checkSite(SITE, dependencies({ fetch: site({ [SITE]: timeout as unknown as Error }).fetch }))).toMatchObject({ state: "unreachable", detail: "No answer: the request timed out after 15 s." });
	});

	test("follows redirects to the page that answers", async () => {
		const { fetch, requests } = site({
			[SITE]: { status: 302, headers: { location: "/next" } },
			"https://login.kit-example.com/next": { status: 301, headers: { location: "https://www.google.com/" } },
			"https://www.google.com/": { status: 200, body: "<html><title>Google</title></html>" },
		});
		expect(await checkSite(SITE, dependencies({ fetch }))).toMatchObject({ state: "redirected", detail: "Redirected to www.google.com (HTTP 200).", httpStatus: 200, finalUrl: "https://www.google.com/" });
		expect(requests.map((request) => request.url)).toEqual([SITE, "https://login.kit-example.com/next", "https://www.google.com/"]);
	});

	test("a parking page at the end of a redirect is parking", async () => {
		const { fetch } = site({
			[SITE]: { status: 302, headers: { location: "https://www.hugedomains.com/domain_profile.cfm?d=kit-example.com" } },
			"https://www.hugedomains.com/domain_profile.cfm?d=kit-example.com": { status: 200, body: "<html><title>kit-example.com is for sale</title></html>" },
		});
		expect(await checkSite(SITE, dependencies({ fetch }))).toMatchObject({ state: "parked", finalUrl: "https://www.hugedomains.com/domain_profile.cfm?d=kit-example.com" });
	});

	test("never follows a redirect into the private network", async () => {
		const { fetch, requests } = site({ [SITE]: { status: 302, headers: { location: "http://internal.kit-example.com/admin" } } });
		const assertPublicHost = async (host: string) => {
			if (host === "internal.kit-example.com") throw new AbuseInputError("The destination resolves to a non-public network address.");
		};
		expect(await checkSite(SITE, dependencies({ fetch, assertPublicHost }))).toMatchObject({
			state: "unreachable",
			detail: "No answer: The destination resolves to a non-public network address.",
			finalUrl: "http://internal.kit-example.com/admin",
		});
		expect(requests.map((request) => request.url)).toEqual([SITE]);
	});

	test("an endless redirect is unreachable", async () => {
		const { fetch, requests } = site({ [SITE]: { status: 302, headers: { location: SITE } } });
		expect(await checkSite(SITE, dependencies({ fetch }))).toMatchObject({ state: "unreachable", detail: "No answer: The reported site host exceeded the redirect limit." });
		expect(requests).toHaveLength(9);
	});

	test("an RDAP hold suspends the domain and its statuses are kept", async () => {
		const registry = rdap(["client hold", "client transfer prohibited"]);
		const { fetch } = site({ [SITE]: { status: 200, body: KIT } });
		expect(await checkSite(SITE, dependencies({ fetch, rdap: registry.dependencies }))).toMatchObject({
			state: "domain_suspended",
			detail: "The registry lists the domain as client hold.",
			httpStatus: 200,
			domainStatuses: ["client hold", "client transfer prohibited"],
		});
		// RDAP asks for the registrable domain, not the visited host.
		expect(registry.asked).toEqual(["kit-example.com"]);
	});

	test("an RDAP failure does not fail the check", async () => {
		const { fetch } = site({ [SITE]: { status: 200, body: KIT } });
		expect(await checkSite(SITE, dependencies({ fetch, rdap: rdap(new Error("HTTP 429")).dependencies }))).toMatchObject({ state: "online", domainStatuses: [] });
	});

	test("an IP target is visited without DNS or RDAP", async () => {
		const url = "http://198.51.100.20/login.php";
		const dns = resolver({ a: ["203.0.113.99"] });
		const registry = rdap(["client hold"]);
		const { fetch } = site({ [url]: { status: 404, body: "Not Found" } });
		expect(await checkSite(url, dependencies({ fetch, dns, rdap: registry.dependencies }))).toMatchObject({ state: "removed", resolvedAddresses: ["198.51.100.20"], domainStatuses: [] });
		expect(dns.calls).toEqual([]);
		expect(registry.asked).toEqual([]);
	});

	test("a platform tenant's domain is the platform's and is not looked up", async () => {
		const url = "https://kit-example.pages.dev/";
		const registry = rdap(["client hold"]);
		const { fetch } = site({ [url]: { status: 200, body: KIT } });
		expect(await checkSite(url, dependencies({ fetch, rdap: registry.dependencies }))).toMatchObject({ state: "online", domainStatuses: [] });
		expect(registry.asked).toEqual([]);
	});

	test("a body beyond the bound or not text is judged by its status alone", async () => {
		const huge = `<html><body><h1>This domain is for sale!</h1>${"x".repeat(600 * 1024)}</body></html>`;
		expect(await checkSite(SITE, dependencies({ fetch: site({ [SITE]: { status: 200, body: huge } }).fetch }))).toMatchObject({ state: "online", detail: "HTTP 200." });
		const binary = site({ [SITE]: { status: 200, body: "This domain is for sale!", headers: { "content-type": "application/zip" } } });
		expect(await checkSite(SITE, dependencies({ fetch: binary.fetch }))).toMatchObject({ state: "online" });
	});

	test("a check interrupted by its job is not recorded as the site failing", async () => {
		const controller = new AbortController();
		const fetch = async () => {
			controller.abort(new Error("Abuse worker is stopping."));
			throw new DOMException("The operation was aborted.", "AbortError");
		};
		await expect(checkSite(SITE, dependencies({ fetch, signal: controller.signal }))).rejects.toThrow("Abuse worker is stopping.");
	});
});

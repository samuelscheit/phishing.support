import { describe, expect, test } from "bun:test";

import { resolveAbuseTarget, type ResolverDependencies } from "../resolver";
import { registrarRdapUrl } from "./rdap";

function resolverWith(routes: Record<string, Record<string, unknown>>, requested: string[] = []): ResolverDependencies {
	return {
		assertPublicHost: async () => undefined,
		resolveDomainAddresses: async () => [],
		port43Query: async () => "",
		fetch: async (input) => {
			const key = String(input);
			requested.push(key);
			const payload = routes[key];
			return payload ? new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/rdap+json" } }) : new Response(null, { status: 404 });
		},
	};
}

function abuse(email: string) {
	return { roles: ["abuse"], vcardArray: ["vcard", [["fn", {}, "text", "Abuse Contact"], ["email", {}, "text", email]]] };
}

function registry(domain: string, registrarId: number, registryAbuse: string, relatedHref?: string) {
	return {
		ldhName: domain,
		links: [
			{ rel: "self", href: `https://rdap.registry.example/domain/${domain}`, type: "application/rdap+json" },
			...(relatedHref ? [{ rel: "related", href: relatedHref, type: "application/rdap+json" }] : []),
		],
		entities: [{ roles: ["registrar"], publicIds: [{ type: "IANA Registrar ID", identifier: String(registrarId) }], entities: [abuse(registryAbuse)] }],
	};
}

describe("registrar RDAP and contact fallbacks", () => {
	test("the registrar's own RDAP contact is reported first and the registry's stale one becomes its fallback", async () => {
		// keychainagent.pro: the .pro registry names abuse@eranet.com (rejected by Eranet's mail
		// server); Eranet's own RDAP names support@tnet.hk. Registrar 999 here has no form.
		const requested: string[] = [];
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "lure.example", targetType: "domain", observedUrls: [] },
			resolverWith({
				"https://rdap.org/domain/lure.example": registry("lure.example", 999, "abuse@registrar.example", "https://rdap.registrar.example/v1/domain/lure.example"),
				"https://rdap.registrar.example/v1/domain/lure.example": { entities: [{ roles: ["registrar"], entities: [abuse("support@registrar-helpdesk.example")] }] },
			}, requested),
		);
		expect(requested).toContain("https://rdap.registrar.example/v1/domain/lure.example");
		expect(result.routes.filter((route) => route.routeType === "email")).toHaveLength(1);
		expect(result.routes[0]).toMatchObject({ routeType: "email", verifiedEmail: "support@registrar-helpdesk.example", status: "verified" });
		expect(result.routes[0]?.resolverProvenance).toMatchObject({
			email: "support@registrar-helpdesk.example",
			source: "registrar_rdap",
			fallbackContacts: [{ email: "abuse@registrar.example", source: "domain_rdap" }],
		});
	});

	test("an unreachable registrar RDAP keeps the registry contact and records why", async () => {
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "lure.example", targetType: "domain", observedUrls: [] },
			resolverWith({ "https://rdap.org/domain/lure.example": registry("lure.example", 999, "abuse@registrar.example", "https://rdap.registrar.example/v1/domain/lure.example") }),
		);
		expect(result.routes[0]).toMatchObject({ verifiedEmail: "abuse@registrar.example" });
		expect(result.routes[0]?.resolverProvenance).not.toHaveProperty("fallbackContacts");
		expect(result.resolverSnapshot).toMatchObject({ registrarRdap: { url: "https://rdap.registrar.example/v1/domain/lure.example", error: "not_found" } });
	});

	test("a registrar with its own abuse form gets that form, not its mailboxes", async () => {
		const result = await resolveAbuseTarget(
			{ normalizedTarget: "keychainagent.pro", targetType: "domain", observedUrls: ["https://keychainagent.pro/wksxgj/x"] },
			resolverWith({ "https://rdap.org/domain/keychainagent.pro": registry("keychainagent.pro", 1868, "abuse@eranet.com") }),
		);
		// Netcraft supplements every web target; the registrar route replaces only the mailbox.
		const domainRoutes = result.routes.filter((route) => route.resolverProvenance.match !== "supplemental_provider_target_rule");
		expect(domainRoutes).toHaveLength(1);
		expect(domainRoutes[0]).toMatchObject({
			routeKey: "provider_submission:eranet:registrar",
			providerRegistryKey: "eranet",
			routeType: "provider_submission",
			status: "verified",
			resolverProvenance: { match: "registrar_iana_id", registrarId: 1868 },
		});
		expect(domainRoutes[0]?.verifiedEmail).toBeUndefined();
	});

	test("only an HTTPS related link to a domain record counts as the registrar's RDAP", () => {
		const base = { links: [{ rel: "self", href: "https://rdap.registry.example/domain/a.example" }] };
		expect(registrarRdapUrl({ links: [...base.links, { rel: "related", href: "https://rdap.tnet.hk/v1/domain/a.example", type: "application/rdap+json" }] })).toBe("https://rdap.tnet.hk/v1/domain/a.example");
		expect(registrarRdapUrl({ links: [...base.links, { rel: "related", href: "http://rdap.tnet.hk/v1/domain/a.example" }] })).toBeUndefined();
		expect(registrarRdapUrl({ links: [...base.links, { rel: "related", href: "https://registrar.example/whois", type: "text/html" }] })).toBeUndefined();
		expect(registrarRdapUrl({ links: [...base.links, { rel: "related", href: "https://rdap.tnet.hk/v1/entity/1868" }] })).toBeUndefined();
		expect(registrarRdapUrl({ links: [{ rel: "self", href: "https://rdap.x.example/domain/a.example" }, { rel: "related", href: "https://rdap.x.example/domain/a.example" }] })).toBeUndefined();
	});
});

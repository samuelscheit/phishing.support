import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { getPortalProviderForRegistrarId } from "../registry";
import { extractRegistrarIdFromRdap, resolveAbuseTarget, type ResolverDependencies } from "../../resolver";
import { gnameServiceIdentity } from "./config";
import { GNAME_PROVIDER } from "./definition";
import { gnameDefinitionHasValidHash, gnameDefinitionMatchesPin } from "./definition_integrity";
import { createGnameRegistrarRoute } from "./route";

const environmentNames = [
	"ABUSE_GNAME_ENABLED",
	"ABUSE_GNAME_SERVICE_NAME",
	"ABUSE_GNAME_SERVICE_MAILBOX",
	"ABUSE_GNAME_IDENTITY_VERIFIED",
] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

function rdapResponse(payload: Record<string, unknown>): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/rdap+json" },
	});
}

function resolverWith(routes: Record<string, Record<string, unknown>>): ResolverDependencies {
	return {
		assertPublicHost: async () => undefined,
		fetch: async (input) => {
			const payload = routes[String(input)];
			return payload ? rdapResponse(payload) : new Response(null, { status: 404 });
		},
	};
}

beforeEach(() => {
	delete process.env.ABUSE_GNAME_ENABLED;
	process.env.ABUSE_GNAME_SERVICE_NAME = "Phishing Support";
	process.env.ABUSE_GNAME_SERVICE_MAILBOX = "gname-reports@phishing.support";
	process.env.ABUSE_GNAME_IDENTITY_VERIFIED = "true";
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("GNAME registrar route", () => {
	test("creates a disabled route without silently dropping its reviewed definition pin", () => {
		const route = createGnameRegistrarRoute({ registrarId: 1923, resolutionSnapshot: { source: "rdap" } });

		expect(route).toMatchObject({
			routeKey: "gname",
			providerRegistryKey: "gname",
			providerDisplayName: "GNAME",
			routeType: "skyvern_portal",
			providerDefinitionVersion: GNAME_PROVIDER.version,
			providerDefinitionHash: GNAME_PROVIDER.contentHash,
			resolverProvenance: { registrarId: 1923, match: "exact_iana_registrar_id" },
			serviceIdentity: gnameServiceIdentity(),
			status: "no_route",
			verificationResult: { verified: false, reason: "provider_route_disabled_or_unproven" },
		});
	});

	test("enables only the provider route while preserving the exact definition pin", () => {
		process.env.ABUSE_GNAME_ENABLED = "true";
		const route = createGnameRegistrarRoute({ registrarId: 4542, resolutionSnapshot: { source: "rdap" } });

		expect(route).toMatchObject({
			status: "resolving",
			providerDefinitionVersion: GNAME_PROVIDER.version,
			providerDefinitionHash: GNAME_PROVIDER.contentHash,
			verificationResult: undefined,
		});
	});

	test("rejects a stale or tampered provider-definition pin", () => {
		// This is the established reviewed definition pin. A schema change must
		// intentionally update both the definition version and this assertion.
		expect(GNAME_PROVIDER.contentHash).toBe("31186cc1e584357c660186e54efff4c507982e8ebeed837cd23b4ce8601f5587");
		expect(gnameDefinitionHasValidHash()).toBeTrue();
		expect(gnameDefinitionMatchesPin(GNAME_PROVIDER, GNAME_PROVIDER.version, GNAME_PROVIDER.contentHash)).toBeTrue();
		expect(gnameDefinitionMatchesPin(GNAME_PROVIDER, `${GNAME_PROVIDER.version}-changed`, GNAME_PROVIDER.contentHash)).toBeFalse();
		expect(gnameDefinitionMatchesPin(GNAME_PROVIDER, GNAME_PROVIDER.version, "tampered")).toBeFalse();
	});

	test("matches only exact IANA registrar identifiers, never registrar display text", async () => {
		expect(getPortalProviderForRegistrarId(1923)?.definition.key).toBe("gname");
		expect(getPortalProviderForRegistrarId(3941)?.definition.key).toBe("gname");
		expect(getPortalProviderForRegistrarId(4542)?.definition.key).toBe("gname");
		expect(getPortalProviderForRegistrarId(4543)).toBeUndefined();
		expect(extractRegistrarIdFromRdap({ handle: "IANA-1923" })).toBe(1923);
		expect(extractRegistrarIdFromRdap({ publicIds: [{ type: "iAnA  ReGiStRaR\tID", identifier: "1923" }] })).toBe(1923);
		expect(extractRegistrarIdFromRdap({ name: "Gname.com Pte. Ltd.", publicIds: [{ type: "other", identifier: "1923" }] })).toBeUndefined();
		expect(extractRegistrarIdFromRdap({ publicIds: [{ type: "Not IANA Registrar ID", identifier: "1923" }] })).toBeUndefined();
		expect(extractRegistrarIdFromRdap({ publicIds: [{ type: "IANA Registrar ID (claimed)", identifier: "1923" }] })).toBeUndefined();

		const result = await resolveAbuseTarget(
			{ normalizedTarget: "example.com", targetType: "domain", observedUrls: [] },
			resolverWith({
				"https://rdap.org/domain/example.com": {
					entities: [{ roles: ["registrar"], handle: "NOT-GNAME", name: "Gname.com Pte. Ltd.", publicIds: [{ type: "IANA Registrar ID", identifier: "999" }] }],
				},
			}),
		);
		expect(result.routes[0]).toMatchObject({ providerRegistryKey: "manual_unroutable", routeType: "manual_unroutable" });
	});
});

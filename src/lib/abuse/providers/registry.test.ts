import { describe, expect, test } from "bun:test";

import type { PortalProvider } from "./contracts";
import { createPortalProviderRegistry } from "./registry";

function testProvider(key: string, registrarIds: number[]): PortalProvider {
	return {
		definition: {
			key,
			displayName: key,
			version: "test",
			contentHash: "test",
			routeType: "skyvern_portal",
			registrarIds,
			verifiedDomains: ["provider.example"],
			allowedReplyLinkDomains: ["provider.example"],
			escalation: { allowExplicitUnmonitoredReplyLink: false },
		},
		createRegistrarRoute: () => {
			throw new Error("not needed by registry tests");
		},
		verifyRoute: async () => undefined,
		runPortal: async () => undefined,
		reconcileRun: async () => undefined,
	};
}

describe("portal provider registry", () => {
	test("indexes providers by exact registrar ID without a provider-name branch", () => {
		const first = testProvider("first", [101]);
		const second = testProvider("second", [202]);
		const registry = createPortalProviderRegistry([first, second]);

		expect(registry.get("first")).toBe(first);
		expect(registry.getForRegistrarId(202)).toBe(second);
		expect(registry.getForRegistrarId(203)).toBeUndefined();
		expect(registry.getForRegistrarId(undefined)).toBeUndefined();
	});

	test("rejects duplicate provider keys and overlapping registrar IDs at composition time", () => {
		expect(() => createPortalProviderRegistry([
			testProvider("same", [101]),
			testProvider("same", [202]),
		])).toThrow("Duplicate abuse provider key same");
		expect(() => createPortalProviderRegistry([
			testProvider("first", [101]),
			testProvider("second", [101]),
		])).toThrow("Registrar ID 101 is registered by both first and second");
	});
});

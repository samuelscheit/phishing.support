import { describe, expect, test } from "bun:test";

import type { ProviderSubmissionProvider } from "./submission_contracts";
import { createProviderSubmissionRegistry } from "./submission_registry";

function testProvider(key: string, exactMailboxes: readonly string[], supplemental = false): ProviderSubmissionProvider {
	return {
		definition: { key, displayName: key, version: "test", contentHash: "test", exactMailboxes, supplemental },
		submit: async () => ({ submittedTargets: ["example.com"] }),
	};
}

describe("provider submission registry", () => {
	test("indexes only exact canonical mailboxes", () => {
		const cloudflare = testProvider("cloudflare", ["Abuse@Cloudflare.EXAMPLE"]);
		const tencent = testProvider("tencent", ["abuse@tencent.example"]);
		const registry = createProviderSubmissionRegistry([cloudflare, tencent]);

		expect(registry.get("cloudflare")).toBe(cloudflare);
		expect(registry.getForMailbox(" abuse@cloudflare.example ")).toBe(cloudflare);
		expect(registry.getForMailbox("abuse@tencent.example")).toBe(tencent);
		expect(registry.getForMailbox("abuse@sub.cloudflare.example")).toBeUndefined();
		expect(registry.getForMailbox("not-abuse@cloudflare.example")).toBeUndefined();
		expect(registry.getForMailbox("not a mailbox")).toBeUndefined();
		expect(registry.getForMailbox(undefined)).toBeUndefined();
	});

	test("lists every supplemental provider, including one also selected by mailbox", () => {
		const selected = testProvider("selected", ["abuse@selected.example"]);
		const supplementalOnly = testProvider("supplemental-only", [], true);
		const selectedAndSupplemental = testProvider("selected-and-supplemental", ["abuse@both.example"], true);
		const registry = createProviderSubmissionRegistry([selected, supplementalOnly, selectedAndSupplemental]);

		expect(registry.list()).toEqual([selected, supplementalOnly, selectedAndSupplemental]);
		expect(registry.listSupplemental()).toEqual([supplementalOnly, selectedAndSupplemental]);
		expect(registry.getForMailbox("abuse@both.example")).toBe(selectedAndSupplemental);
	});

	test("rejects duplicate provider keys", () => {
		expect(() => createProviderSubmissionRegistry([
			testProvider("same", ["first@example.com"]),
			testProvider("same", ["second@example.com"]),
		])).toThrow("Duplicate provider submission key same");
	});

	test("rejects duplicate canonical mailbox ownership", () => {
		expect(() => createProviderSubmissionRegistry([
			testProvider("first", ["ABUSE@example.com"]),
			testProvider("second", [" abuse@EXAMPLE.com "]),
		])).toThrow("Exact mailbox abuse@example.com is registered by both first and second");
	});

	test("rejects malformed plain mailbox definitions", () => {
		expect(() => createProviderSubmissionRegistry([
			testProvider("invalid", ["Provider <abuse@example.com>"]),
		])).toThrow("Invalid exact mailbox for provider submission invalid");
	});

	test("requires contact-selected providers to declare a mailbox but permits supplemental-only providers", () => {
		expect(() => createProviderSubmissionRegistry([
			testProvider("contact-only", []),
		])).toThrow("Provider submission contact-only must declare an exact mailbox or be supplemental");

		const supplementalOnly = testProvider("supplemental-only", [], true);
		const registry = createProviderSubmissionRegistry([supplementalOnly]);
		expect(registry.listSupplemental()).toEqual([supplementalOnly]);
	});
});

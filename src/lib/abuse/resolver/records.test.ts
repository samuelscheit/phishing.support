import { describe, expect, test } from "bun:test";

import { normalizeMailbox } from "./records";

describe("normalizeMailbox", () => {
	test("normalises a published mailbox", () => {
		expect(normalizeMailbox(" <Abuse@HE.net> ")).toBe("abuse@he.net");
		expect(normalizeMailbox("abuse@sub.example-host.com")).toBe("abuse@sub.example-host.com");
		expect(normalizeMailbox("noc@examples.com")).toBe("noc@examples.com");
	});

	test("refuses the placeholders registries publish (RFC 2606/6761 reserved names)", () => {
		// Production 2026-11-22: an RDAP chain for 198.251.81.14 listed nobody@example.com, and a report was mailed there.
		for (const value of ["nobody@example.com", "abuse@EXAMPLE.net", "a@example.org", "a@mail.example.com", "a@example", "a@host.example", "a@x.test", "a@x.invalid", "a@localhost", "a@x.localhost", "a@printer.local"]) {
			expect(normalizeMailbox(value), value).toBeUndefined();
		}
	});

	test("refuses malformed and oversized values", () => {
		for (const value of [undefined, "", "abuse", "abuse@", "@he.net", "a b@he.net", `${"a".repeat(320)}@he.net`]) expect(normalizeMailbox(value)).toBeUndefined();
	});
});

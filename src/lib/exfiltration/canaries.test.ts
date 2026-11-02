import { describe, expect, test } from "bun:test";

import { createExfiltrationCanaries, fictionalPhone } from "./canaries";

function seeded(seed: number) {
	let call = 0;
	return (size: number) => Buffer.alloc(size, ++call * seed);
}

describe("probe canaries", () => {
	test("are unique-looking, syntactically valid, and Luhn-valid", () => {
		const canaries = createExfiltrationCanaries(seeded(17));
		expect(canaries.marker).toMatch(/^psprobe_[a-f0-9]{16}$/);
		expect(canaries.phone).toMatch(/^\+\d{11}$/);
		expect(canaries.oneTimeCode).toMatch(/^\d{6}$/);
		expect(canaries.cardNumber).toMatch(/^\d{16}$/);
		const sum = [...canaries.cardNumber].reduce((total, digit, index) => {
			let value = Number(digit);
			if (index % 2 === 0) value = value * 2 > 9 ? value * 2 - 9 : value * 2;
			return total + value;
		}, 0);
		expect(sum % 10).toBe(0);
	});

	test("email is a non-deliverable .invalid address traceable to this probe's suffix", () => {
		const canaries = createExfiltrationCanaries(seeded(17));
		const suffix = canaries.marker.replace("psprobe_", "");
		expect(canaries.email).toBe(`probe.${suffix}@probe-canary.invalid`);
		// .invalid is reserved by RFC 6761: it never resolves, so it cannot deliver.
		expect(canaries.email.endsWith(".invalid")).toBeTrue();
	});

	test("never uses a domain that can receive mail or a real person's address", () => {
		for (let seed = 1; seed <= 20; seed++) {
			const { email } = createExfiltrationCanaries(seeded(seed));
			expect(email).not.toMatch(/@(?:example\.(?:com|net|org)|gmail\.com|outlook\.com|yahoo\.com|hotmail\.com|icloud\.com)$/i);
			expect(email.endsWith(".invalid")).toBeTrue();
		}
	});

	test("phone is drawn only from NANPA's fictitious 555-0100..0199 block", () => {
		for (let seed = 1; seed <= 40; seed++) {
			const { phone } = createExfiltrationCanaries(seeded(seed));
			expect(phone).toMatch(/^\+1212555(?:01\d\d)$/);
			const line = Number(phone.slice(-4));
			expect(line).toBeGreaterThanOrEqual(100);
			expect(line).toBeLessThanOrEqual(199);
		}
	});
});

describe("fictional phone numbers", () => {
	test("span exactly the reserved line range, first and last", () => {
		expect(fictionalPhone(0)).toBe("+12125550100");
		expect(fictionalPhone(99)).toBe("+12125550199");
	});

	test("reject any index outside the reserved block", () => {
		expect(() => fictionalPhone(-1)).toThrow(RangeError);
		expect(() => fictionalPhone(100)).toThrow(RangeError);
		expect(() => fictionalPhone(1.5)).toThrow(RangeError);
	});
});

import { expect, test } from "bun:test";

import { createExfiltrationCanaries } from "./canaries";

test("probe canaries are unique-looking, syntactically valid, and Luhn-valid", () => {
	let call = 0;
	const canaries = createExfiltrationCanaries((size) => Buffer.alloc(size, ++call * 17));
	expect(canaries.marker).toMatch(/^psprobe_[a-f0-9]{16}$/);
	expect(canaries.email).toContain(canaries.marker);
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

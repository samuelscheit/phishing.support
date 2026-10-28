import { randomBytes } from "node:crypto";

import type { ExfiltrationCanaries } from "./types";

export function createExfiltrationCanaries(random: (size: number) => Buffer = randomBytes): ExfiltrationCanaries {
	const suffix = random(8).toString("hex");
	const marker = `psprobe_${suffix}`;
	const uniqueDigits = [...random(8)].map((value) => value.toString().padStart(3, "0")).join("").slice(0, 15);
	const sum = [...uniqueDigits].reduce((total, digit, index) => {
		let value = Number(digit);
		if (index % 2 === 0) value = value * 2 > 9 ? value * 2 - 9 : value * 2;
		return total + value;
	}, 0);
	return {
		marker,
		email: `audit+${marker}@example.com`,
		password: `A9!${marker}!qZ`,
		phone: `+1555${uniqueDigits.slice(0, 7)}`,
		cardNumber: `${uniqueDigits}${(10 - sum % 10) % 10}`,
		oneTimeCode: uniqueDigits.slice(0, 6),
	};
}

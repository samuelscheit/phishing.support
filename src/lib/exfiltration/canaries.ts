import { randomBytes } from "node:crypto";

import type { ExfiltrationCanaries } from "./types";

/**
 * NANPA reserves 555-0100 through 555-0199 for fictitious, non-working numbers
 * (nanpa.com, 555 line numbers: "will remain reserved for entertainment/advertising").
 * A probe phone drawn from that span cannot reach a subscriber, and the area code
 * is fixed so the only variation is the line inside the reserved block.
 */
const FICTIONAL_AREA_CODE = "212";
const FICTIONAL_LINE_FIRST = 100;
const FICTIONAL_LINE_COUNT = 100;

/** A non-working North American number inside NANPA's fictitious 555-0100..0199 block. */
export function fictionalPhone(lineIndex: number): string {
	if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= FICTIONAL_LINE_COUNT) {
		throw new RangeError("A fictional probe line index must be an integer from 0 to 99.");
	}
	// The line is the last four digits: 0100 through 0199, so the full number is
	// +1 212 555 0100 .. +1 212 555 0199.
	const line = String(FICTIONAL_LINE_FIRST + lineIndex).padStart(4, "0");
	return `+1${FICTIONAL_AREA_CODE}555${line}`;
}

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
		// `.invalid` is reserved by RFC 6761 for names that never resolve, so the
		// address cannot deliver to anyone, while its shape passes format checks.
		email: `probe.${suffix}@probe-canary.invalid`,
		password: `A9!${marker}!qZ`,
		phone: fictionalPhone(Number(uniqueDigits.slice(0, 4)) % FICTIONAL_LINE_COUNT),
		cardNumber: `${uniqueDigits}${(10 - sum % 10) % 10}`,
		oneTimeCode: uniqueDigits.slice(0, 6),
	};
}

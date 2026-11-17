import { createHash } from "node:crypto";

/**
 * An account a page asks its visitors to pay. Only identifiers whose own
 * checksum proves them are taken, so a reference number or a random hex
 * string on a page never becomes a payment lead.
 */
export type PaymentReceiver = {
	kind: "iban" | "bitcoin" | "tron" | "ethereum";
	/** Normalized: an IBAN without spaces in upper case, an Ethereum address in lower case. */
	value: string;
};

/** Length of a complete IBAN per country (ISO 13616 registry, SWIFT release 2024). */
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
	AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24,
	DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27,
	GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
	LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24, PL: 28,
	PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25, SV: 28,
	TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20, YE: 30,
};

export function isValidIban(candidate: string): boolean {
	const iban = candidate.replace(/\s+/g, "").toUpperCase();
	if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban) || IBAN_LENGTHS[iban.slice(0, 2)] !== iban.length) return false;
	const rearranged = iban.slice(4) + iban.slice(0, 4);
	let remainder = 0;
	for (const character of rearranged) {
		const digits = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
		for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
	}
	return remainder === 1;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(value: string): Buffer | undefined {
	let number = 0n;
	for (const character of value) {
		const digit = BASE58.indexOf(character);
		if (digit < 0) return undefined;
		number = number * 58n + BigInt(digit);
	}
	const hex = number === 0n ? "" : number.toString(16);
	const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
	const leadingZeros = value.match(/^1*/)![0].length;
	return Buffer.concat([Buffer.alloc(leadingZeros), body]);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

/** A Base58Check payload of 21 bytes (version and hash) whose checksum holds; its version byte. */
function base58CheckVersion(value: string): number | undefined {
	const decoded = base58Decode(value);
	if (!decoded || decoded.length !== 25) return undefined;
	const payload = decoded.subarray(0, 21);
	const checksum = sha256(sha256(payload)).subarray(0, 4);
	return checksum.equals(decoded.subarray(21)) ? decoded[0] : undefined;
}

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONSTANT = 1;
const BECH32M_CONSTANT = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
	let checksum = 1;
	for (const value of values) {
		const top = checksum >>> 25;
		checksum = ((checksum & 0x1ffffff) << 5) ^ value;
		for (let bit = 0; bit < 5; bit += 1) if ((top >>> bit) & 1) checksum ^= BECH32_GENERATOR[bit]!;
	}
	return checksum >>> 0;
}

/** A Bitcoin mainnet SegWit address (BIP 173 for version 0, BIP 350 for later versions). */
function isValidBech32Bitcoin(candidate: string): boolean {
	const address = candidate.toLowerCase();
	if (candidate !== address && candidate !== candidate.toUpperCase()) return false;
	const separator = address.lastIndexOf("1");
	if (address.slice(0, separator) !== "bc" || address.length < 14 || address.length > 74) return false;
	const data: number[] = [];
	for (const character of address.slice(separator + 1)) {
		const value = BECH32_CHARSET.indexOf(character);
		if (value < 0) return false;
		data.push(value);
	}
	if (data.length < 7) return false;
	const expanded = [...[..."bc"].map((c) => c.charCodeAt(0) >> 5), 0, ...[..."bc"].map((c) => c.charCodeAt(0) & 31)];
	const constant = bech32Polymod([...expanded, ...data]);
	const witnessVersion = data[0]!;
	if (witnessVersion > 16) return false;
	const expected = witnessVersion === 0 ? BECH32_CONSTANT : BECH32M_CONSTANT;
	if (constant !== expected) return false;
	// The witness program is 2 to 40 bytes; version 0 allows exactly 20 or 32.
	const programBits = (data.length - 7) * 5;
	const programBytes = Math.floor(programBits / 8);
	if (programBytes < 2 || programBytes > 40) return false;
	return witnessVersion !== 0 || programBytes === 20 || programBytes === 32;
}

export function isValidBitcoinAddress(candidate: string): boolean {
	if (/^bc1/i.test(candidate)) return isValidBech32Bitcoin(candidate);
	// Mainnet pay-to-pubkey-hash (version 0x00, "1…") and pay-to-script-hash (0x05, "3…").
	const version = /^[13]/.test(candidate) ? base58CheckVersion(candidate) : undefined;
	return version === 0x00 || version === 0x05;
}

/** A TRON address: Base58Check with the mainnet version byte 0x41 ("T…"). */
export function isValidTronAddress(candidate: string): boolean {
	return candidate.startsWith("T") && base58CheckVersion(candidate) === 0x41;
}

const IBAN_PATTERN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}\b/g;
const BITCOIN_PATTERN = /\b(?:bc1[ac-hj-np-z02-9]{11,71}|BC1[AC-HJ-NP-Z02-9]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})\b/g;
const TRON_PATTERN = /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g;
/** Exactly 40 hex digits: a 64-digit transaction hash or a longer hex blob never matches. */
const ETHEREUM_PATTERN = /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g;

/**
 * Every IBAN and crypto address a page's text names whose checksum holds,
 * each once, in the order the page names them. An IBAN may be written in
 * groups of four; the longest valid reading of a match is taken.
 */
export function paymentReceivers(text: string): PaymentReceiver[] {
	const found = new Map<string, PaymentReceiver>();
	const add = (receiver: PaymentReceiver) => {
		const key = `${receiver.kind}:${receiver.value}`;
		if (!found.has(key)) found.set(key, receiver);
	};
	for (const match of text.matchAll(IBAN_PATTERN)) {
		// Text after a grouped IBAN ("DE89 3704 0044 0532 0130 00 BIC …") can be
		// swallowed into the match; shorten until a registered length validates.
		const compact = match[0].replace(/ /g, "");
		const length = IBAN_LENGTHS[compact.slice(0, 2)];
		if (length && compact.length >= length && isValidIban(compact.slice(0, length))) add({ kind: "iban", value: compact.slice(0, length) });
	}
	for (const match of text.matchAll(BITCOIN_PATTERN)) {
		if (isValidBitcoinAddress(match[0])) add({ kind: "bitcoin", value: /^bc1/i.test(match[0]) ? match[0].toLowerCase() : match[0] });
	}
	for (const match of text.matchAll(TRON_PATTERN)) {
		if (isValidTronAddress(match[0])) add({ kind: "tron", value: match[0] });
	}
	for (const match of text.matchAll(ETHEREUM_PATTERN)) {
		const value = match[0].toLowerCase();
		// The zero address and other placeholders are never a receiver.
		if (!/^0x(?:0{40}|f{40})$/.test(value)) add({ kind: "ethereum", value });
	}
	return [...found.values()];
}

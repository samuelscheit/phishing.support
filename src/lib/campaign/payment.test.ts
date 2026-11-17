import { describe, expect, test } from "bun:test";

import { isValidBitcoinAddress, isValidIban, isValidTronAddress, paymentReceivers } from "./payment";

describe("payment receivers", () => {
	test("validates IBANs by country length and the ISO 7064 mod-97 checksum", () => {
		expect(isValidIban("DE89370400440532013000")).toBe(true);
		expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
		expect(isValidIban("NL91ABNA0417164300")).toBe(true);
		// One changed digit breaks the checksum; a wrong length for the country is refused.
		expect(isValidIban("DE89370400440532013001")).toBe(false);
		expect(isValidIban("DE8937040044053201300")).toBe(false);
		expect(isValidIban("XX89370400440532013000")).toBe(false);
	});

	test("validates Bitcoin addresses: Base58Check P2PKH/P2SH and bech32/bech32m SegWit", () => {
		expect(isValidBitcoinAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(true);
		expect(isValidBitcoinAddress("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")).toBe(true);
		// Checksums cross-checked with the BIP 173 reference implementation:
		// version 0 needs the bech32 constant, version 1 (Taproot) the bech32m one.
		expect(isValidBitcoinAddress("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe(true);
		expect(isValidBitcoinAddress("BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ")).toBe(true);
		expect(isValidBitcoinAddress("bc1qw508d6qejxtdg4c5ad6sr2kmtvq6l2xz3rcf0w")).toBe(false);
		expect(isValidBitcoinAddress("bc1qw508d6qejxtdg4c5ad6sr3sn0cmqrf7q")).toBe(false);
		expect(isValidBitcoinAddress("bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297")).toBe(true);
		// A mixed-case bech32 string and a broken Base58 checksum are refused.
		expect(isValidBitcoinAddress("bc1qAr0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe(false);
		expect(isValidBitcoinAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toBe(false);
	});

	test("validates TRON addresses by their Base58Check version byte", () => {
		expect(isValidTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t")).toBe(true);
		expect(isValidTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBe(false);
		// A valid Bitcoin P2PKH address has the wrong version byte for TRON.
		expect(isValidTronAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(false);
	});

	test("finds every receiver a page's text names, once each, in page order", () => {
		const text = [
			"Überweisen Sie die Gebühr an IBAN: DE89 3704 0044 0532 0130 00 BIC COBADEFFXXX.",
			"Or pay 0.01 BTC to 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa (again: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa).",
			"USDT (TRC20): TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
			"ETH: 0xDE0B295669a9FD93d5F28D9Ec85E40f4cb697BAe",
		].join("\n");
		expect(paymentReceivers(text)).toEqual([
			{ kind: "iban", value: "DE89370400440532013000" },
			{ kind: "bitcoin", value: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" },
			{ kind: "tron", value: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
			{ kind: "ethereum", value: "0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae" },
		]);
	});

	test("takes nothing that only looks like a receiver", () => {
		const text = [
			"Order DE00 1234 5678 9012 3456 78 is on its way.",
			"Transaction 0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060 confirmed.",
			"Burn address 0x0000000000000000000000000000000000000000.",
			"Tracking number 1Z999AA10123456784 and reference T1234567890ABCDEFGHJKLMNPQRSTUVWXY.",
			"Hash a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 without prefix.",
		].join("\n");
		expect(paymentReceivers(text)).toEqual([]);
	});
});

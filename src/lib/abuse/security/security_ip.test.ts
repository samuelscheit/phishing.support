import { describe, expect, test } from "bun:test";
import { isIP } from "node:net";

import { isPublicIp } from "./security";

/**
 * The hand-rolled byte parser and CIDR matcher `isPublicIp` used before it
 * moved to ipaddr.js, kept verbatim as the oracle the differential test below
 * compares against.
 */
function parseIpv4Bytes(value: string): Buffer | undefined {
	const parts = value.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
	const bytes = parts.map(Number);
	if (bytes.some((part) => part < 0 || part > 255)) return undefined;
	return Buffer.from(bytes);
}

function parseIpv6Bytes(value: string): Buffer | undefined {
	if (value.includes("%") || isIP(value) !== 6) return undefined;
	let source = value.toLowerCase();
	if (source.includes(".")) {
		const separator = source.lastIndexOf(":");
		if (separator === -1) return undefined;
		const ipv4 = parseIpv4Bytes(source.slice(separator + 1));
		if (!ipv4) return undefined;
		const high = ipv4.readUInt16BE(0).toString(16);
		const low = ipv4.readUInt16BE(2).toString(16);
		source = `${source.slice(0, separator)}:${high}:${low}`;
	}

	const doubleColon = source.indexOf("::");
	if (doubleColon !== -1 && source.indexOf("::", doubleColon + 1) !== -1) return undefined;
	const head = doubleColon === -1 ? source.split(":") : source.slice(0, doubleColon).split(":").filter(Boolean);
	const tail = doubleColon === -1 ? [] : source.slice(doubleColon + 2).split(":").filter(Boolean);
	if (head.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || tail.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
	const zeros = 8 - head.length - tail.length;
	if ((doubleColon === -1 && zeros !== 0) || (doubleColon !== -1 && zeros < 1)) return undefined;
	const groups = [...head, ...Array(zeros).fill("0"), ...tail];
	if (groups.length !== 8) return undefined;
	const bytes = Buffer.alloc(16);
	groups.forEach((group, index) => bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2));
	return bytes;
}

function ipBytes(value: string): Buffer | undefined {
	return isIP(value) === 4 ? parseIpv4Bytes(value) : parseIpv6Bytes(value);
}

function isInCidr(value: string, base: string, prefixLength: number): boolean {
	const target = ipBytes(value);
	const network = ipBytes(base);
	if (!target || !network || target.byteLength !== network.byteLength) return false;
	let remaining = prefixLength;
	for (let index = 0; index < target.byteLength; index++) {
		if (remaining <= 0) return true;
		const width = Math.min(8, remaining);
		const mask = (0xff << (8 - width)) & 0xff;
		if ((target[index] & mask) !== (network[index] & mask)) return false;
		remaining -= width;
	}
	return true;
}

const NON_PUBLIC_IPV4: ReadonlyArray<readonly [string, number]> = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.0.2.0", 24],
	["192.31.196.0", 24],
	["192.52.193.0", 24],
	["192.88.99.0", 24],
	["192.175.48.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["198.51.100.0", 24],
	["203.0.113.0", 24],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
	["255.255.255.255", 32],
];

const NON_PUBLIC_IPV6: Array<[string, number]> = [
	["::", 128],
	["::1", 128],
	["::ffff:0:0", 96],
	["64:ff9b::", 96],
	["64:ff9b:1::", 48],
	["100::", 64],
	["100:0:0:1::", 64],
	// IANA reserves this protocol-assignment block for non-general-purpose
	// uses (including Teredo, benchmarking, ORCHID, AMT, and AS112). Keeping
	// the parent block here prevents a newly-added child allocation from being
	// accidentally accepted until this list is reviewed again.
	["2001::", 23],
	["2001:db8::", 32],
	["2002::", 16],
	["2620:4f:8000::", 48],
	["3fff::", 20],
	["5f00::", 16],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
];

/** Reject local, special-use, documentation, benchmark, and unroutable addresses. */
export function referenceIsPublicIp(value: string): boolean {
	const version = isIP(value);
	// Node accepts IPv6 zone identifiers in `isIP()`, but those are scoped
	// local interface addresses, not portable public targets.  Requiring our
	// byte parser to succeed also makes every CIDR comparison fail closed.
	if (!version || !ipBytes(value)) return false;
	const blocked = version === 4 ? NON_PUBLIC_IPV4 : NON_PUBLIC_IPV6;
	if (blocked.some(([base, prefix]) => isInCidr(value, base, prefix))) return false;
	// IPv6 global-unicast space is 2000::/3. Anything outside it is local,
	// multicast, experimental, or otherwise not a public Internet destination.
	return version === 4 || isInCidr(value, "2000::", 3);
}

/** Every special-use boundary: the first and last address of each blocked range and their neighbours. */
function boundaries(): string[] {
	const out: string[] = [];
	for (const [base, prefix] of NON_PUBLIC_IPV4) {
		const start = base.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
		const size = 2 ** (32 - prefix);
		for (const value of [start - 1, start, start + 1, start + size - 2, start + size - 1, start + size]) {
			if (value < 0 || value > 0xffffffff) continue;
			out.push([24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join("."));
		}
	}
	for (const [base, prefix] of NON_PUBLIC_IPV6) {
		const bytes = ipBytes(base)!;
		const first = BigInt(`0x${bytes.toString("hex")}`);
		const size = 2n ** BigInt(128 - prefix);
		for (const value of [first - 1n, first, first + 1n, first + size - 1n, first + size]) {
			if (value < 0n || value >= 2n ** 128n) continue;
			const hex = value.toString(16).padStart(32, "0");
			out.push(hex.match(/.{4}/g)!.join(":"));
		}
	}
	return out;
}

const HAND_PICKED = [
	// public
	"8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "198.17.255.255", "198.20.0.0",
	"2001:4860:4860::8888", "2606:4700:4700::1111", "2a00:1450:4001::1", "2000::1", "3ffe::1", "2001:200::1", "2002:0808:0808::1",
	// private, loopback, link-local, CGNAT, documentation, multicast, reserved
	"0.0.0.0", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255",
	"192.168.0.1", "192.0.0.8", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
	"::", "::1", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "2001::1", "2001:1ff::1", "2002::1", "3fff::1", "3fff:fff::1", "5f00::1", "64:ff9b::808:808", "100::1", "4000::1", "1::1",
	// IPv4-mapped / compatible / embedded
	"::ffff:8.8.8.8", "::ffff:127.0.0.1", "::ffff:808:808", "::FFFF:10.0.0.1", "0:0:0:0:0:ffff:1.2.3.4", "::8.8.8.8", "::1.2.3.4", "64:ff9b::8.8.8.8", "2001:db8::1.2.3.4", "1:2:3:4:5:6:1.2.3.4", "2001:4860:4860:0:0:0:8.8.8.8",
	// zone ids
	"fe80::1%eth0", "fe80::1%1", "2001:4860:4860::8888%eth0", "::1%lo", "8.8.8.8%eth0", "::%", "%",
	// malformed
	"", " ", "not-an-ip", "8.8.8", "8.8.8.8.8", "8.8.8.256", "256.1.1.1", "1.2.3.04", "010.0.0.1", "01.1.1.1", "8.8.8.8 ", " 8.8.8.8", "8.8.8.8\n", "0x7f.0.0.1", "127.1", "2130706433", "0177.0.0.1", "1e3.0.0.1", "-1.0.0.1", "+1.0.0.1", "８.８.８.８",
	"[::1]", "[2001:4860:4860::8888]", "::1::", "1::2::3", ":::", ":1", "1:", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8", "12345::1", "g::1", "::ffff:1.2.3", "::ffff:1.2.3.4.5", "::ffff:256.1.1.1", "::ffff:01.2.3.4", "::1.2.3.4:5", "1.2.3.4::", "::ffff:", "ffff::ffff:",
	"1:2:3:4:5:6:7::", "::2:3:4:5:6:7:8", "1::3:4:5:6:7:8", "1:2:3:4:5:6:7:8:", "::0", "0:0:0:0:0:0:0:0", "0:0:0:0:0:0:0:1", "localhost", "example.com", "null", "undefined",
];

function randomAddress(random: () => number): string {
	const pick = random();
	const octet = () => Math.floor(random() * 256);
	if (pick < 0.4) return `${octet()}.${octet()}.${octet()}.${octet()}`;
	const group = () => (random() < 0.3 ? "0" : Math.floor(random() * 65536).toString(16));
	const groups = Array.from({ length: 8 }, group);
	if (pick < 0.7) return groups.join(":");
	const start = Math.floor(random() * 7);
	const end = start + 1 + Math.floor(random() * (8 - start));
	const compressed = [...groups.slice(0, start), "", ...groups.slice(end)].join(":");
	if (pick < 0.85) return compressed.replace(/^:(?!:)/, "::").replace(/:$/, "::") || "::";
	return `::ffff:${octet()}.${octet()}.${octet()}.${octet()}`;
}

function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296;
		return state / 4294967296;
	};
}

describe("isPublicIp against the byte-parser reference", () => {
	test("agrees on every range boundary and hand-picked edge case", () => {
		for (const value of [...boundaries(), ...HAND_PICKED]) expect(isPublicIp(value), JSON.stringify(value)).toBe(referenceIsPublicIp(value));
	});

	test("agrees on 100,000 random IPv4 and IPv6 literals", () => {
		const random = seeded(20260511);
		const mismatches: string[] = [];
		for (let index = 0; index < 100_000; index++) {
			const value = randomAddress(random);
			if (isPublicIp(value) !== referenceIsPublicIp(value)) mismatches.push(value);
		}
		expect(mismatches).toEqual([]);
	});

	test("agrees on mutated literals (stray characters, truncations, case)", () => {
		const random = seeded(7);
		const noise = ["%", "%eth0", " ", "\t", ":", ".", "..", "::", "0", "00", "x", "-", "/", "/24", "[", "]", "\0"];
		const pool = [...boundaries(), ...HAND_PICKED];
		const mismatches: string[] = [];
		for (let index = 0; index < 60_000; index++) {
			const base = random() < 0.2 ? randomAddress(random) : pool[Math.floor(random() * pool.length)]!;
			const at = Math.floor(random() * (base.length + 1));
			const value = random() < 0.5 ? base.slice(0, at) + noise[Math.floor(random() * noise.length)] + base.slice(at) : random() < 0.5 ? base.slice(0, at) : base.toUpperCase();
			if (isPublicIp(value) !== referenceIsPublicIp(value)) mismatches.push(JSON.stringify(value));
		}
		expect(mismatches).toEqual([]);
	});
});

describe("isPublicIp verdicts", () => {
	test("public unicast addresses pass", () => {
		for (const value of ["8.8.8.8", "93.184.216.34", "172.32.0.0", "100.128.0.0", "2001:4860:4860::8888", "2606:4700:4700::1111", "2a00:1450:4001::1"]) expect(isPublicIp(value), value).toBeTrue();
	});

	test("private, loopback, link-local, CGNAT, documentation, multicast and reserved ranges fail", () => {
		for (const value of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "2001::1", "2002::1", "3fff::1", "64:ff9b::808:808", "100::1", "4000::1"]) expect(isPublicIp(value), value).toBeFalse();
	});

	test("an IPv4-mapped or embedded address is never public, whatever the IPv4 part", () => {
		for (const value of ["::ffff:8.8.8.8", "::ffff:808:808", "::ffff:127.0.0.1", "::8.8.8.8", "64:ff9b::8.8.8.8"]) expect(isPublicIp(value), value).toBeFalse();
	});

	test("zone identifiers, leading zeros, hex, octal, brackets and other non-literals fail closed", () => {
		for (const value of ["fe80::1%eth0", "2001:4860:4860::8888%eth0", "8.8.8.8%eth0", "010.0.0.1", "08.8.8.8", "0x08.8.8.8", "0177.0.0.1", "2130706433", "127.1", "[2001:4860:4860::8888]", "8.8.8.8 ", "", "example.com"]) expect(isPublicIp(value), JSON.stringify(value)).toBeFalse();
		expect(isIP("08.8.8.8")).toBe(0);
	});
});

import { isIP } from "node:net";

/** An address as a number and its family's width in bits. */
export type AddressBits = { value: bigint; bits: 32 | 128 };

/** An IPv4 or IPv6 address as a number and its width in bits, or undefined when it is not one. */
export function addressBits(address: string): AddressBits | undefined {
	const version = isIP(address);
	if (version === 4) {
		return { value: address.split(".").reduce((sum, octet) => (sum << 8n) | BigInt(Number(octet)), 0n), bits: 32 };
	}
	if (version !== 6) return undefined;
	let text = address.toLowerCase().split("%")[0]!;
	// An embedded IPv4 tail (`::ffff:192.0.2.1`) becomes two hextets.
	const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
	if (v4) {
		const tail = addressBits(v4[1]!)!.value;
		text = `${text.slice(0, -v4[1]!.length)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
	}
	const [head, rest] = text.split("::") as [string, string | undefined];
	const left = head ? head.split(":") : [];
	const right = rest === undefined ? [] : rest ? rest.split(":") : [];
	const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
	return { value: groups.reduce((sum, group) => (sum << 16n) | BigInt(parseInt(group, 16)), 0n), bits: 128 };
}

/** The canonical text of an address: dotted IPv4, compressed lowercase IPv6. */
export function formatAddress({ value, bits }: AddressBits): string {
	if (bits === 32) return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 0xffn).toString()).join(".");
	const groups = Array.from({ length: 8 }, (_, index) => ((value >> BigInt(112 - index * 16)) & 0xffffn).toString(16));
	// The URL parser applies RFC 5952's compression.
	return new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
}

/** The network address of the `length`-bit prefix holding `address`. */
function networkOf(address: AddressBits, length: number): AddressBits {
	const shift = BigInt(address.bits - length);
	return { value: (address.value >> shift) << shift, bits: address.bits };
}

/**
 * The CIDR one level less specific than the range `start`–`end`: the smallest
 * prefix that holds the whole range and is larger than it. An RDAP server
 * answers a query for it with the next object up from the range's own.
 * Undefined for an invalid range or one that is already the whole family.
 */
export function enclosingPrefix(start: string, end: string): string | undefined {
	const low = addressBits(start);
	const high = addressBits(end);
	if (!low || !high || low.bits !== high.bits || low.value > high.value) return undefined;
	const covering = low.bits - (low.value ^ high.value).toString(2).replace(/^0$/, "").length;
	const exact = networkOf(low, covering).value === low.value && networkOf(high, covering).value + ((1n << BigInt(low.bits - covering)) - 1n) === high.value;
	const length = exact ? covering - 1 : covering;
	if (length < 0) return undefined;
	return `${formatAddress(networkOf(low, length))}/${length}`;
}

/** True when the range `inner` lies inside `outer` and is smaller. */
export function strictlyInside(inner: { start: string; end: string }, outer: { start: string; end: string }): boolean {
	const [a, b, c, d] = [inner.start, inner.end, outer.start, outer.end].map(addressBits);
	if (!a || !b || !c || !d || new Set([a.bits, b.bits, c.bits, d.bits]).size !== 1) return false;
	return c.value <= a.value && b.value <= d.value && (c.value < a.value || b.value < d.value);
}

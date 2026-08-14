import dns from "node:dns/promises";
import net from "node:net";
import { isIP } from "node:net";

import { AbuseInputError, assertPublicDnsHost, isPublicIp } from "../security";
import type { ResolverDependencies } from "./types";

const MAX_WHOIS_BYTES = 1024 * 1024;
const WHOIS_TIMEOUT_MS = 12_000;

async function defaultPort43Query(server: string, query: string): Promise<string> {
	if (!/^[a-z0-9.-]+$/i.test(server) || !/^[a-z0-9:.\-]+$/i.test(query)) {
		throw new AbuseInputError("WHOIS request did not satisfy the strict resolver contract.");
	}

	const addresses = isIP(server)
		? [{ address: server, family: isIP(server) }]
		: await dns.lookup(server, { all: true, verbatim: true });
	const publicAddresses = addresses.filter((address) => isPublicIp(address.address));
	if (publicAddresses.length === 0) throw new AbuseInputError("WHOIS server resolves to a non-public address.");

	let lastError: unknown;
	for (const address of publicAddresses) {
		try {
			return await new Promise<string>((resolve, reject) => {
				const socket = net.createConnection({ host: address.address, port: 43, family: address.family });
				const chunks: Buffer[] = [];
				let size = 0;
				const fail = (error: Error) => {
					socket.destroy();
					reject(error);
				};
				socket.setTimeout(WHOIS_TIMEOUT_MS, () => fail(new Error("WHOIS query timed out.")));
				socket.once("error", reject);
				socket.once("connect", () => socket.write(`${query}\r\n`, "utf8"));
				socket.on("data", (chunk: Buffer) => {
					size += chunk.byteLength;
					if (size > MAX_WHOIS_BYTES) {
						fail(new Error("WHOIS response exceeded its size limit."));
						return;
					}
					chunks.push(Buffer.from(chunk));
				});
				socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			});
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("Unable to query the authoritative WHOIS server.");
}

/** Query an authoritative port-43 service and turn failures into snapshot data. */
export async function queryPort43(server: string | undefined, query: string, dependencies: ResolverDependencies): Promise<{ raw?: string; error?: string }> {
	if (!server) return {};
	try {
		const assertHost = dependencies.assertPublicHost ?? assertPublicDnsHost;
		await assertHost(server);
		const raw = await (dependencies.port43Query ?? defaultPort43Query)(server, query);
		if (Buffer.byteLength(raw) > MAX_WHOIS_BYTES) throw new Error("WHOIS response exceeded its size limit.");
		return { raw };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

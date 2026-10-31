import { createHash, webcrypto } from "node:crypto";

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

/**
 * Independent RFC 3161 time-stamping authorities, tried in order. A token
 * proves that the hashed evidence existed at the authority's time; it is
 * verifiable by anyone with `openssl ts -verify`.
 */
export const TIMESTAMP_AUTHORITIES = [
	{ name: "DigiCert", url: "http://timestamp.digicert.com" },
	{ name: "FreeTSA", url: "https://freetsa.org/tsr" },
] as const;

const TIMESTAMP_TIMEOUT_MS = 15_000;
const SHA256_OID = "2.16.840.1.101.3.4.2.1";

pkijs.setEngine("node", new pkijs.CryptoEngine({ name: "node", crypto: webcrypto as unknown as Crypto }));

export type EvidenceTimestamp = {
	authority: string;
	authorityUrl: string;
	/** The authority's own time for the evidence, ISO 8601 UTC. */
	time: string;
	serialNumber: string;
	/** The DER-encoded TimeStampResp, as served by the authority. */
	token: Buffer;
};

export type TimestampFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The DER TimeStampReq for a SHA-256 digest, with a nonce and the authority's certificate requested. */
export function timestampRequest(sha256: Buffer, nonce: Buffer): Buffer {
	const request = new pkijs.TimeStampReq({
		version: 1,
		messageImprint: new pkijs.MessageImprint({
			hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256_OID }),
			hashedMessage: new asn1js.OctetString({ valueHex: sha256 }),
		}),
		nonce: new asn1js.Integer({ valueHex: nonce }),
		certReq: true,
	});
	return Buffer.from(request.toSchema().toBER());
}

/**
 * The bytes of an OCTET STRING in either BER form: primitive, as authorities
 * send it, or constructed from segments, as some encoders write it.
 */
function octetStringBytes(value: asn1js.OctetString): Uint8Array<ArrayBuffer> {
	if (!value.idBlock.isConstructed) return new Uint8Array(value.valueBlock.valueHexView);
	const segments = (value.valueBlock.value as asn1js.OctetString[]).map(octetStringBytes);
	return new Uint8Array(Buffer.concat(segments));
}

function unsignedHex(bytes: ArrayBuffer | Uint8Array): string {
	return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("hex").replace(/^(?:00)+(?=.)/, "");
}

/**
 * Read a TimeStampResp and check it answers this request: granted, over
 * exactly this content's SHA-256 and this nonce, and signed by the
 * certificate the token carries. A reply that fails any check is not evidence
 * of anything and is rejected.
 */
export async function verifyTimestampResponse(der: Buffer, content: Buffer, nonce: Buffer): Promise<{ time: Date; serialNumber: string }> {
	const sha256 = createHash("sha256").update(content).digest();
	const response = pkijs.TimeStampResp.fromBER(new Uint8Array(der));
	const status = response.status.status;
	if (status !== pkijs.PKIStatus.granted && status !== pkijs.PKIStatus.grantedWithMods) {
		throw new Error(`The time-stamping authority refused the request (PKIStatus ${status}).`);
	}
	if (!response.timeStampToken) throw new Error("The time-stamping authority returned no token.");
	const signed = new pkijs.SignedData({ schema: response.timeStampToken.content });
	const encapsulated = signed.encapContentInfo.eContent;
	if (!encapsulated) throw new Error("The timestamp token carries no TSTInfo.");
	const info = pkijs.TSTInfo.fromBER(octetStringBytes(encapsulated).slice().buffer);
	if (info.messageImprint.hashAlgorithm.algorithmId !== SHA256_OID
		|| !Buffer.from(info.messageImprint.hashedMessage.valueBlock.valueHexView).equals(sha256)) {
		throw new Error("The timestamp token covers a different digest than the evidence.");
	}
	if (!info.nonce || unsignedHex(info.nonce.valueBlock.valueHexView) !== unsignedHex(nonce)) {
		throw new Error("The timestamp token answers a different request (nonce mismatch).");
	}
	// pkijs re-hashes `data` against the TSTInfo imprint, then checks the
	// signature over TSTInfo with the signer certificate the token carries.
	const result = await signed.verify({ signer: 0, data: new Uint8Array(content).buffer, checkChain: false, extendedMode: true });
	if (!result.signatureVerified) throw new Error(`The timestamp token signature does not verify: ${result.message ?? "invalid signature"}`);
	return { time: info.genTime, serialNumber: unsignedHex(info.serialNumber.valueBlock.valueHexView) };
}

/**
 * Timestamp content at the first authority that answers with a valid token.
 * Only its SHA-256 leaves this service. Returns undefined when no authority
 * does: the evidence is still kept, only without an independent time.
 */
export async function timestampEvidence(
	content: Buffer,
	dependencies: { fetch?: TimestampFetch; authorities?: readonly { name: string; url: string }[] } = {},
): Promise<EvidenceTimestamp | undefined> {
	const fetcher = dependencies.fetch ?? fetch;
	const sha256 = createHash("sha256").update(content).digest();
	for (const authority of dependencies.authorities ?? TIMESTAMP_AUTHORITIES) {
		const nonce = Buffer.from(webcrypto.getRandomValues(new Uint8Array(8)));
		// A positive INTEGER: clear the sign bit.
		nonce[0] = nonce[0]! & 0x7f;
		try {
			const response = await fetcher(authority.url, {
				method: "POST",
				headers: { "content-type": "application/timestamp-query" },
				body: new Uint8Array(timestampRequest(sha256, nonce)),
				signal: AbortSignal.timeout(TIMESTAMP_TIMEOUT_MS),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const token = Buffer.from(await response.arrayBuffer());
			const { time, serialNumber } = await verifyTimestampResponse(token, content, nonce);
			return { authority: authority.name, authorityUrl: authority.url, time: time.toISOString(), serialNumber, token };
		} catch (error) {
			console.warn(`Timestamping at ${authority.name} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return undefined;
}

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import sharp from "sharp";

import { buildWebsiteEvidence, websiteEvidenceFiles } from "./package";
import { stampAddressBar } from "./address_bar";
import { timestampEvidence, verifyTimestampResponse } from "./timestamp";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

async function pagePng(width = 1200, height = 800): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 3, background: "#3366cc" } }).png().toBuffer();
}

/**
 * A minimal RFC 3161 authority: it signs a TSTInfo over the request's digest
 * and nonce with a throwaway self-signed certificate, as a real TSA does.
 */
async function testAuthority(options: { lieAboutDigest?: boolean } = {}) {
	const crypto = pkijs.getCrypto(true);
	const keys = await crypto.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
	const certificate = new pkijs.Certificate();
	certificate.version = 2;
	certificate.serialNumber = new asn1js.Integer({ value: 1 });
	for (const target of [certificate.issuer, certificate.subject]) {
		target.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.BmpString({ value: "Test TSA" }) }));
	}
	certificate.notBefore.value = new Date(Date.now() - 86_400_000);
	certificate.notAfter.value = new Date(Date.now() + 86_400_000);
	certificate.extensions = [new pkijs.Extension({ extnID: "2.5.29.37", critical: true, extnValue: new pkijs.ExtKeyUsage({ keyPurposes: ["1.3.6.1.5.5.7.3.8"] }).toSchema().toBER(false) })];
	await certificate.subjectPublicKeyInfo.importKey(keys.publicKey);
	await certificate.sign(keys.privateKey, "SHA-256");
	const genTime = new Date("2026-10-31T09:55:04Z");

	const fetch = async (_url: string, init: RequestInit) => {
		const body = init.body as Uint8Array;
		const request = pkijs.TimeStampReq.fromBER(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);
		const digest = options.lieAboutDigest ? sha256(Buffer.from("something else")) : request.messageImprint.hashedMessage.valueBlock.valueHexView;
		const info = new pkijs.TSTInfo({
			version: 1,
			policy: "1.2.3.4.1",
			messageImprint: new pkijs.MessageImprint({
				hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: request.messageImprint.hashAlgorithm.algorithmId }),
				hashedMessage: new asn1js.OctetString({ valueHex: digest }),
			}),
			serialNumber: new asn1js.Integer({ value: 4711 }),
			genTime,
			ordering: false,
			...(request.nonce ? { nonce: new asn1js.Integer({ valueHex: request.nonce.valueBlock.valueHexView }) } : {}),
		});
		const encapContentInfo = new pkijs.EncapsulatedContentInfo({ eContentType: "1.2.840.113549.1.9.16.1.4" });
		// DER, as real authorities send it: pkijs's constructor would split eContent into a constructed string.
		encapContentInfo.eContent = new asn1js.OctetString({ valueHex: info.toSchema().toBER(false) });
		const signed = new pkijs.SignedData({
			version: 3,
			encapContentInfo,
			signerInfos: [new pkijs.SignerInfo({ version: 1, sid: new pkijs.IssuerAndSerialNumber({ issuer: certificate.issuer, serialNumber: certificate.serialNumber }) })],
			certificates: [certificate],
		});
		await signed.sign(keys.privateKey, 0, "SHA-256");
		const response = new pkijs.TimeStampResp({
			status: new pkijs.PKIStatusInfo({ status: pkijs.PKIStatus.granted }),
			timeStampToken: new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.SIGNED_DATA, content: signed.toSchema(true) }),
		});
		return new Response(new Uint8Array(response.toSchema().toBER(false)), { headers: { "content-type": "application/timestamp-reply" } });
	};
	return { fetch, genTime };
}

describe("RFC 3161 timestamps", () => {
	test("a token over exactly this content is accepted with the authority's time", async () => {
		const authority = await testAuthority();
		const content = Buffer.from('{"capture":"evidence"}\n');
		const stamp = await timestampEvidence(content, { fetch: authority.fetch, authorities: [{ name: "Test TSA", url: "https://tsa.test/" }] });
		expect(stamp).toMatchObject({ authority: "Test TSA", time: "2026-10-31T09:55:04.000Z", serialNumber: "1267" });
		expect(stamp!.token.byteLength).toBeGreaterThan(500);
	});

	test("a token over other content, or answering another request, is rejected", async () => {
		const authority = await testAuthority();
		const content = Buffer.from("evidence");
		const stamp = await timestampEvidence(content, { fetch: authority.fetch, authorities: [{ name: "Test TSA", url: "https://tsa.test/" }] });
		// The same valid token proves nothing about different bytes.
		await expect(verifyTimestampResponse(stamp!.token, Buffer.from("tampered evidence"), Buffer.from([1]))).rejects.toThrow("different digest");

		const lying = await testAuthority({ lieAboutDigest: true });
		expect(await timestampEvidence(content, { fetch: lying.fetch, authorities: [{ name: "Liar", url: "https://liar.test/" }] })).toBeUndefined();
	});

	test("falls back to the next authority, and returns nothing when none answers", async () => {
		const authority = await testAuthority();
		const calls: string[] = [];
		const fetch = async (url: string, init: RequestInit) => {
			calls.push(url);
			if (url === "https://down.test/") return new Response("busy", { status: 503 });
			return authority.fetch(url, init);
		};
		const stamp = await timestampEvidence(Buffer.from("x"), { fetch, authorities: [{ name: "Down", url: "https://down.test/" }, { name: "Up", url: "https://up.test/" }] });
		expect(calls).toEqual(["https://down.test/", "https://up.test/"]);
		expect(stamp?.authority).toBe("Up");

		const none = await timestampEvidence(Buffer.from("x"), { fetch: async () => { throw new Error("offline"); }, authorities: [{ name: "Down", url: "https://down.test/" }] });
		expect(none).toBeUndefined();
	});
});

describe("address bar", () => {
	test("adds a bar above the page and leaves every page pixel unchanged", async () => {
		const page = await pagePng();
		const stamped = await stampAddressBar(page, {
			url: "https://sites.google.com/view/revert-change",
			capturedAt: new Date("2026-10-31T09:55:03.412Z"),
			route: "Tor exit",
			caseId: "374851334366564352",
			screenshotSha256: sha256(page).toString("hex"),
		});
		const { width, height } = await sharp(stamped).metadata();
		expect(width).toBe(1200);
		expect(height).toBe(800 + 96);
		// The page below the bar is the original screenshot, byte for byte in pixels.
		const below = await sharp(stamped).extract({ left: 0, top: 96, width: 1200, height: 800 }).raw().toBuffer();
		expect(below.equals(await sharp(page).raw().toBuffer())).toBeTrue();
		// The bar itself is drawn: it is not a flat strip.
		const bar = await sharp(stamped).extract({ left: 0, top: 0, width: 1200, height: 96 }).stats();
		expect(bar.channels.slice(0, 3).some((channel) => channel.stdev > 10)).toBeTrue();
	});

	test("escapes markup in a hostile URL instead of injecting it", async () => {
		const page = await pagePng(600, 300);
		await expect(stampAddressBar(page, {
			url: "https://evil.test/?q=</text><image href='file:///etc/passwd'/>&x=\"",
			capturedAt: new Date(),
			route: "Tor exit",
			caseId: "1",
			screenshotSha256: "0".repeat(64),
		})).resolves.toBeInstanceOf(Buffer);
	});
});

describe("website evidence package", () => {
	test("names every file by SHA-256 with the URL, time, route and navigation, and timestamps that manifest", async () => {
		const authority = await testAuthority();
		const screenshotPng = await pagePng();
		const mhtml = Buffer.from("From: <Saved by Blink>\r\n\r\n<html>kit</html>");
		const timestamped: Buffer[] = [];
		const evidence = await buildWebsiteEvidence({
			caseId: "374851334366564352",
			submittedUrl: "https://sites.google.com/view/revert-change",
			capturedUrl: "https://sites.google.com/view/revert-change",
			capturedAt: new Date("2026-10-31T09:55:03.412Z"),
			route: "Tor exit",
			navigationHops: [{ index: 0, url: "https://sites.google.com/view/revert-change", hostname: "sites.google.com", status: 200, contentCaptured: true }],
			screenshotPng,
			mhtml,
		}, {
			timestamp: async (content) => {
				timestamped.push(content);
				return timestampEvidence(content, { fetch: authority.fetch, authorities: [{ name: "Test TSA", url: "https://tsa.test/" }] });
			},
		});

		const manifest = JSON.parse(evidence.manifest.toString("utf8"));
		expect(manifest.capture).toEqual({
			submittedUrl: "https://sites.google.com/view/revert-change",
			capturedUrl: "https://sites.google.com/view/revert-change",
			capturedAt: "2026-10-31T09:55:03.412Z",
			route: "Tor exit",
			navigation: [{ index: 0, url: "https://sites.google.com/view/revert-change", status: 200, contentCaptured: true }],
		});
		expect(manifest.files).toEqual([
			{ name: "website.png", mimeType: "image/png", sha256: sha256(screenshotPng).toString("hex"), size: screenshotPng.byteLength },
			{ name: "website-stamped.png", mimeType: "image/png", sha256: sha256(evidence.stampedScreenshotPng!).toString("hex"), size: evidence.stampedScreenshotPng!.byteLength },
			{ name: "website.mhtml", mimeType: "text/mhtml", sha256: sha256(mhtml).toString("hex"), size: mhtml.byteLength },
		]);
		// Exactly the stored manifest bytes were timestamped, so its token verifies against them.
		expect(timestamped).toEqual([evidence.manifest]);
		expect(evidence.timestamp?.time).toBe("2026-10-31T09:55:04.000Z");
		expect(websiteEvidenceFiles(evidence).map(({ name, mimeType }) => ({ name, mimeType }))).toEqual([
			{ name: "website-stamped.png", mimeType: "image/png" },
			{ name: "evidence-manifest.json", mimeType: "application/json" },
			{ name: "evidence-manifest.tsr", mimeType: "application/timestamp-reply" },
		]);
	});

	test("the manifest is canonical: the same capture always hashes the same", async () => {
		const facts = {
			caseId: "1",
			submittedUrl: "https://a.test/",
			capturedUrl: "https://a.test/",
			capturedAt: new Date("2026-01-01T00:00:00Z"),
			navigationHops: [],
			mhtml: Buffer.from("m"),
		};
		const first = await buildWebsiteEvidence(facts, { timestamp: async () => undefined });
		const second = await buildWebsiteEvidence({ ...facts, navigationHops: [] }, { timestamp: async () => undefined });
		expect(first.manifest.equals(second.manifest)).toBeTrue();
		// Without a screenshot or a reachable authority the package still records the MHTML.
		expect(JSON.parse(first.manifest.toString()).files.map((file: { name: string }) => file.name)).toEqual(["website.mhtml"]);
		expect(websiteEvidenceFiles(first).map((file) => file.name)).toEqual(["evidence-manifest.json"]);
	});
});

describe("address bar text", () => {
	test("the URL is drawn as readable glyphs, not as one repeated box", async () => {
		const page = await pagePng(800, 200);
		const stamp = (url: string) => stampAddressBar(page, { url, capturedAt: new Date("2026-10-31T09:55:03Z"), route: "Tor exit", caseId: "1", screenshotSha256: "0".repeat(64) });
		// Two URLs of the same length but different letters must draw differently.
		const bar = async (png: Buffer) => sharp(png).extract({ left: 60, top: 20, width: 400, height: 24 }).raw().toBuffer();
		const narrow = await bar(await stamp("https://iiiiiiiiiiiii.test/"));
		const wide = await bar(await stamp("https://MWMWMWMWMWMWM.test/"));
		expect(narrow.equals(wide)).toBeFalse();
	});
});

import { describe, expect, test } from "bun:test";

import { sha256Hex } from "../security";
import { discoverSiblingDomains, findKitSiblingCandidates, kitFingerprintsFromMhtml } from "./siblings";

const CSS = "body{" + "color:#123456;".repeat(100) + "}";
const MHTML = Buffer.from([
	"From: <Saved by Blink>",
	"Snapshot-Content-Location: https://login.example.com/",
	"Content-Type: multipart/related; boundary=kit",
	"",
	"--kit",
	"Content-Type: text/html",
	"Content-Location: https://login.example.com/",
	"",
	"<html><link rel=stylesheet href=/kit.css></html>",
	"--kit",
	"Content-Type: text/css",
	"Content-Transfer-Encoding: base64",
	"Content-Location: https://login.example.com/kit.css",
	"",
	Buffer.from(CSS).toString("base64"),
	"--kit--",
	"",
].join("\r\n"), "utf8");

function imageMhtml() {
	const first = Buffer.alloc(2_048, 1);
	const second = Buffer.alloc(2_048, 2);
	return {
		first,
		second,
		mhtml: Buffer.from([
			"From: <Saved by Blink>",
			"Snapshot-Content-Location: https://login.example.com/",
			"Content-Type: multipart/related; boundary=images",
			"",
			"--images",
			"Content-Type: text/html",
			"Content-Location: https://login.example.com/",
			"",
			"<html></html>",
			"--images",
			"Content-Type: image/gif",
			"Content-Transfer-Encoding: base64",
			"Content-Location: https://login.example.com/one.gif",
			"",
			first.toString("base64"),
			"--images",
			"Content-Type: image/gif",
			"Content-Transfer-Encoding: base64",
			"Content-Location: https://login.example.com/two.gif",
			"",
			second.toString("base64"),
			"--images--",
			"",
		].join("\r\n"), "utf8"),
	};
}

describe("origin sibling discovery", () => {
	test("hashes decoded same-host kit resources", async () => {
		expect(await kitFingerprintsFromMhtml(MHTML, "login.example.com")).toEqual([{
			sha256: sha256Hex(CSS),
			mimeType: "text/css",
			url: "https://login.example.com/kit.css",
			size: Buffer.byteLength(CSS),
		}]);
	});

	test("accepts a urlscan candidate only when the swept origin presents its certificate", async () => {
		let requested: URL | undefined;
		let apiKey: string | undefined;
		const result = await discoverSiblingDomains({
			submissionId: 1n,
			originalDomain: "login.example.com",
			originServers: [{ ip: "8.8.8.8", certificate: { names: ["login.example.com"], issuer: "CA", fingerprint256: "AA", notBefore: "2026-01-01", notAfter: "2027-01-01" } }],
		}, {
			apiKey: "secret-test-key",
			loadMhtml: async () => MHTML,
			fetch: async (url, init) => {
				requested = new URL(url);
				apiKey = (init?.headers as Record<string, string>)["API-Key"];
				return new Response(JSON.stringify({ results: [
					{ page: { domain: "sibling.example.net", url: "https://sibling.example.net/signin" }, task: {} },
					{ page: { domain: "unrelated.example.org", url: "https://unrelated.example.org/" }, task: {} },
				] }), { status: 200 });
			},
			probe: async (_ip, domain) => domain === "sibling.example.net"
				? { names: [domain], issuer: "CA", fingerprint256: "BB", notBefore: "2026-01-01", notAfter: "2027-01-01" }
				: { names: ["someone-else.example"], issuer: "CA", fingerprint256: "CC", notBefore: "2026-01-01", notAfter: "2027-01-01" },
		});

		expect(apiKey).toBe("secret-test-key");
		expect(requested?.searchParams.get("q")).toBe(`hash:${sha256Hex(CSS)} AND date:>now-90d`);
		expect(result.candidateCount).toBe(2);
		expect(result.confirmed).toEqual([{
			domain: "sibling.example.net",
			url: "https://sibling.example.net/signin",
			matchingHashes: [sha256Hex(CSS)],
			originIp: "8.8.8.8",
			certificate: { names: ["sibling.example.net"], issuer: "CA", fingerprint256: "BB", notBefore: "2026-01-01", notAfter: "2027-01-01" },
		}]);
	});

	test("requires two matching hashes when candidates are supported only by image assets", async () => {
		const images = imageMhtml();
		const firstHash = sha256Hex(images.first);
		const secondHash = sha256Hex(images.second);
		const result = await findKitSiblingCandidates({ submissionId: 1n, originalDomain: "login.example.com" }, {
			apiKey: "test-key",
			loadMhtml: async () => images.mhtml,
			fetch: async (url) => {
				const query = new URL(url).searchParams.get("q") ?? "";
				const domains = query.includes(firstHash)
					? ["single-image.example.net", "two-images.example.net"]
					: query.includes(secondHash) ? ["two-images.example.net"] : [];
				return new Response(JSON.stringify({ results: domains.map((domain) => ({ page: { domain, url: `https://${domain}/` } })) }), { status: 200 });
			},
		});
		expect(result.candidates).toEqual([{
			domain: "two-images.example.net",
			url: "https://two-images.example.net/",
			matchingHashes: [firstHash, secondHash],
		}]);
	});
});

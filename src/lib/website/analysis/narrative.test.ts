import { describe, expect, test } from "bun:test";

import type { WhoISInfo } from "../info/info";
import { buildWebsiteAnalysisInput, infrastructureEvidence, visitNarrativeEvidence } from "./narrative";

/** What the case's lookups found for rbxcore.pro (submission 380115867024756863), trimmed. */
const WHOIS = {
	rdap: {
		domain: "rbxcore.pro",
		status: ["client transfer prohibited"],
		events: { registration: "2026-11-01T17:30:56.438Z", expiration: "2027-11-01T17:30:56.438Z", "last changed": "2026-11-06T17:31:03.966Z" },
		nameservers: ["mimi.ns.cloudflare.com", "jimmy.ns.cloudflare.com"],
		registrar: { handle: "1647", vcard: { fn: "Hello Internet Corp" }, abuse: { email: "abuse@hello.example" } },
	},
	dns: { A: ["188.114.96.3"], AAAA: [], NS: [], MX: [], CNAME: [], TXT: [] },
	ip_rdaps: [{ ip: "188.114.96.3", name: "CLOUDFLARENET-EU", country: "US", origin_asns: [{ asn: 13335, prefix: "188.114.96.0/24", source: "ripe-stat" }], abuse: { email: "abuse@cloudflare.com" } }],
} as unknown as WhoISInfo;

describe("the website case analysis", () => {
	test("asks for the same sections as the email analysis, judged by the classifier's own rules", () => {
		const page = { requestedUrl: "https://rbxcore.pro/game-copier/", url: "https://rbxcore.pro/game-copier/", hostname: "rbxcore.pro", navigationHops: [{ index: 0, url: "https://rbxcore.pro/game-copier/", hostname: "rbxcore.pro", status: 200, contentCaptured: true }], html: Buffer.from("<html><head><title>RBXCore</title></head></html>"), text: Buffer.from("Game to Studio. One export.") };
		const [system, user] = buildWebsiteAnalysisInput(page, { finding: "No reportable phishing or malware evidence was found.", whois: WHOIS, capturedAt: new Date("2026-11-14T22:04:45Z") });
		for (const section of ["**Verdict**", "**Brand impersonation**", "**Domain and hosting**", "**The visit, step by step**", "**Where the data went**", "**The offered file**", "**Evasion and kit techniques**", "**Indicators of compromise**"]) {
			expect(system.content as string).toContain(section);
		}
		expect(system.content as string).toContain("verify it with web search");
		expect(system.content as string).toContain("A file that reads the visitor's browser cookies");
		const text = (user.content as Array<{ text?: string }>)[0]!.text!;
		expect(text).toContain("age_when_captured: 13 days");
		expect(text).toContain("The analyzed page is https://rbxcore.pro/game-copier/:");
	});

	test("explains the case's decided finding instead of judging the site again", () => {
		const page = { requestedUrl: "https://nova-staking.com/", url: "https://nova-staking.com/account", hostname: "nova-staking.com", navigationHops: [{ index: 0, url: "https://nova-staking.com/account", hostname: "nova-staking.com", status: 200, contentCaptured: true }], html: Buffer.from("<html></html>"), text: Buffer.from("Текущий пароль") };
		const finding = "The page impersonates Orbit and asks visitors for a password, sign-in details, a verification code, or identity details, or leads them to a step that does.";
		const [system, user] = buildWebsiteAnalysisInput(page, { finding });
		const text = (user.content as Array<{ text?: string }>)[0]!.text!;
		expect(text.startsWith(`<case_finding>\n${finding}\n</case_finding>\n`)).toBe(true);
		expect(system.content as string).toContain("never contradict, weaken, or replace it with a verdict of your own");
		expect(system.content as string).toContain("you do not judge the site again");
		expect(system.content as string).not.toContain("or neither, exactly as the definitions above decide");
	});

	test("compacts the registration and hosting facts, with the domain's age when it was captured", () => {
		const facts = infrastructureEvidence(WHOIS, new Date("2026-11-14T22:04:45Z"));
		expect(facts).toContain("domain: rbxcore.pro");
		expect(facts).toContain("age_when_captured: 13 days");
		expect(facts).toContain("registrar: Hello Internet Corp");
		expect(facts).toContain("registrar_abuse: abuse@hello.example");
		expect(facts).toContain("networks[1]{ip,network,country,asn,abuse}:\n    188.114.96.3,CLOUDFLARENET-EU,US,\"13335\",abuse@cloudflare.com");
		expect(infrastructureEvidence(undefined, new Date())).toBe("");
		// A capture before the registration date gives no age rather than a negative one.
		expect(infrastructureEvidence(WHOIS, new Date("2026-10-01T00:00:00Z"))).not.toContain("age_when_captured");
	});

	test("tells the whole visit: each page in order, the agent's account, and every request that carried the synthetic values", () => {
		const evidence = visitNarrativeEvidence({
			finding: "Phishing.",
			pages: [{ url: "https://kit.example/", title: "Verify", text: "Verify your email" }, { url: "https://kit.example/signin", text: `Enter password ${"x".repeat(5_000)}` }],
			visit: {
				outcome: "completed",
				report: { asksForPhone: false, blockedByChallenge: false, stoppedReason: "The sign-in page showed an error." },
				actions: [{ kind: "input_text", text: "Enter the synthetic email" }],
				dataSent: [{ url: "https://api.telegram.org/bot1:x/sendMessage", method: "POST", fields: ["email", "password"], sameSite: false }],
				downloadFailures: [],
			},
			kitResources: [{ url: "https://cdn.kit-assets.example/app.js", mimeType: "application/javascript", size: 1, sha256: "a".repeat(64) }],
		});
		expect(evidence).toContain("visited_pages[2]{step,url,title,text}:\n  1,\"https://kit.example/\",Verify,Verify your email");
		expect(evidence).toContain("stopped_because: The sign-in page showed an error.");
		expect(evidence).toContain("data_sent_during_visit[1]{url,method,values,to_the_site_itself}:\n  \"https://api.telegram.org/bot1:x/sendMessage\",POST,email address and password,false");
		expect(evidence).toContain("Hosts the site's scripts and stylesheets were loaded from: cdn.kit-assets.example.");
		// Other pages are shortened; the analyzed page is given in full elsewhere.
		expect(evidence.length).toBeLessThan(5_000);
		expect(visitNarrativeEvidence({ finding: "Phishing.", visit: { outcome: "completed", actions: [], dataSent: [], downloadFailures: [] } })).toContain("No request during the visit carried the synthetic values off the page.");
	});
});

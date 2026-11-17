import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";

import { buildDossierArchive } from "./archive";
import type { Dossier } from "./dossier";
import { dossierText, siteAnalysisText } from "./archive_text";

const mhtml = Buffer.from("MIME-Version: 1.0\r\n\r\ncaptured page");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const dossier: Dossier = {
	campaignId: "42",
	generatedAt: "2026-11-17T09:00:00.000Z",
	firstSeenAt: "2026-11-10T08:00:00.000Z",
	lastSeenAt: "2026-11-12T08:00:00.000Z",
	impersonates: ["www.dhl.de"],
	dataRequested: ["Passwort"],
	requestedFields: ["password"],
	providers: [{ name: "Hostinger International Ltd.", siteCount: 1, contacts: ["abuse@hostinger.com"] }],
	indicators: [{ kind: "exfiltration_backend", value: "telegram-bot:7001", links: true, evidence: { backendKind: "telegram_bot", telegram: { token: "7001:AAE", chatId: "-1" } }, sites: ["https://dhl-a.com/"] }],
	sites: [{
		submissionId: "11",
		url: "https://dhl-a.com/",
		host: "dhl-a.com",
		firstSeenAt: "2026-11-10T08:00:00.000Z",
		impersonates: ["www.dhl.de"],
		dns: { a: ["203.0.113.7"], aaaa: [], cname: [], ns: [] },
		dataDestinations: [{ url: "https://dhl-a.com/api/send", method: "POST", fields: ["email", "password"], sameSite: true }],
		verdict: { finding: "phishing", basis: "credential_theft", quote: "Bitte bestätigen Sie Ihr Paket", impersonates: { name: "DHL", officialUrl: "https://www.dhl.de/" }, fields: ["E-Mail", "Passwort"], pageUrl: "https://dhl-a.com/" },
		visit: { outcome: "completed", actions: [{ kind: "input_text", text: "Typed into \"E-Mail\"" }, { kind: "click", text: "Clicked \"Weiter\"" }] },
		reportText: "The page impersonates DHL and asks for a password.",
		reports: [{ provider: "Hostinger International Ltd.", target: "dhl-a.com", channel: "email", contact: "abuse@hostinger.com", status: "acknowledged", reportedAt: "2026-11-10T09:00:00.000Z" }],
		evidence: [
			{ artifactId: "1", name: "website.mhtml", kind: "website_mhtml", sha256: sha(mhtml), size: mhtml.length },
			{ artifactId: "2", name: "website.png", kind: "website_png", sha256: sha(png), size: png.length },
			{ artifactId: "3", name: "evidence-manifest.json", kind: "website_evidence", sha256: "0".repeat(64), size: 2 },
			{ artifactId: "4", name: "../../escape.tsr", kind: "website_evidence", sha256: sha(png), size: png.length },
		],
		indicators: [{ kind: "exfiltration_backend", value: "telegram-bot:7001", links: true, evidence: {} }],
	}],
};

async function entries(zip: Uint8Array) {
	const reader = new ZipReader(new Uint8ArrayReader(zip));
	const files = new Map<string, Buffer>();
	for (const entry of await reader.getEntries()) {
		if (entry.directory) continue;
		files.set(entry.filename, Buffer.from(await entry.getData!(new Uint8ArrayWriter())));
	}
	await reader.close();
	return files;
}

describe("dossier archive", () => {
	test("ships the dossier and each evidence file byte for byte, under a safe name", async () => {
		const blobs = new Map<string, Buffer>([["1", mhtml], ["2", png], ["3", Buffer.from("{}")], ["4", png]]);
		const files = await entries(await buildDossierArchive(dossier, { loadArtifact: async (id) => ({ blob: blobs.get(id.toString())! }) }));
		expect([...files.keys()].sort()).toEqual([
			"dossier.json",
			"dossier.txt",
			"evidence/001-dhl-a.com/....escape.tsr",
			"evidence/001-dhl-a.com/analysis.txt",
			"evidence/001-dhl-a.com/website.mhtml",
			"evidence/001-dhl-a.com/website.png",
			"indicators.csv",
			"missing-files.txt",
			"sites.csv",
		]);
		expect(sha(files.get("evidence/001-dhl-a.com/website.mhtml")!)).toBe(sha(mhtml));
		// The manifest's stored bytes do not match its recorded hash, so it is named, not shipped.
		expect(files.get("missing-files.txt")!.toString()).toContain("evidence-manifest.json: the stored bytes do not match the recorded SHA-256");
		expect(files.get("dossier.txt")!.toString()).toBe(dossierText(dossier));
		expect(JSON.parse(files.get("dossier.json")!.toString()).campaignId).toBe("42");
		// Each site's folder says why the site is phishing and what our visit entered where.
		const analysis = files.get("evidence/001-dhl-a.com/analysis.txt")!.toString();
		expect(analysis).toBe(siteAnalysisText(dossier.sites[0]!));
		for (const expected of [
			"Finding: phishing (it collects sign-in credentials), on https://dhl-a.com/.",
			"It imitates DHL, whose official site is https://www.dhl.de/.",
			"The page's own words: \"Bitte bestätigen Sie Ihr Paket\"",
			"Fields it asks for: E-Mail, Passwort.",
			"POST https://dhl-a.com/api/send received the synthetic email address, password (the site's own server).",
			"1. input_text: Typed into \"E-Mail\"",
			"This visit predates the full visit record",
			"Hostinger International Ltd. <abuse@hostinger.com>: reported 2026-11-10 09:00 UTC, confirmed by the provider",
		]) expect(analysis).toContain(expected);
		expect(files.get("sites.csv")!.toString().split("\r\n")[0]).toBe("No,URL,Host,First seen (UTC),Registered,Registrar,Finding,Quote,Data sent,Takedown reports,Linking indicators,Evidence files (SHA-256),Case");
	});

	test("keeps every capture of a site captured again: the newest under its name, earlier ones with their id", async () => {
		const older = Buffer.from("MIME-Version: 1.0\r\n\r\nfirst capture");
		const site = { ...dossier.sites[0]!, evidence: [
			{ artifactId: "10", name: "website.mhtml", kind: "website_mhtml", sha256: sha(older), size: older.length },
			{ artifactId: "20", name: "website.mhtml", kind: "website_mhtml", sha256: sha(mhtml), size: mhtml.length },
		] };
		const blobs = new Map([["10", older], ["20", mhtml]]);
		const files = await entries(await buildDossierArchive({ ...dossier, sites: [site] }, { loadArtifact: async (id) => ({ blob: blobs.get(id.toString())! }) }));
		expect(files.get("evidence/001-dhl-a.com/website.mhtml")!.toString()).toBe(mhtml.toString());
		expect(files.get("evidence/001-dhl-a.com/website.10.mhtml")!.toString()).toBe(older.toString());
	});

	test("names a file that is no longer stored", async () => {
		const files = await entries(await buildDossierArchive({ ...dossier, sites: [{ ...dossier.sites[0]!, evidence: [dossier.sites[0]!.evidence[0]!] }] }, { loadArtifact: async () => undefined }));
		expect(files.get("missing-files.txt")!.toString()).toContain("website.mhtml: no longer stored");
	});
});

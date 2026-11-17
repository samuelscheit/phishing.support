import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";

import { buildDossierArchive } from "./archive";
import type { Dossier } from "./dossier";
import { dossierText } from "./render";

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
		dataDestinations: [{ url: "https://dhl-a.com/api/send", method: "POST", fields: ["password"], sameSite: true }],
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
			"Beweise/001-dhl-a.com/....escape.tsr",
			"Beweise/001-dhl-a.com/website.mhtml",
			"Beweise/001-dhl-a.com/website.png",
			"Dossier.json",
			"Dossier.txt",
			"Fehlende-Dateien.txt",
			"Merkmale.csv",
			"Websites.csv",
		]);
		expect(sha(files.get("Beweise/001-dhl-a.com/website.mhtml")!)).toBe(sha(mhtml));
		// The manifest's stored bytes do not match its recorded hash, so it is named, not shipped.
		expect(files.get("Fehlende-Dateien.txt")!.toString()).toContain("evidence-manifest.json: gespeicherte Bytes passen nicht zur Prüfsumme");
		expect(files.get("Dossier.txt")!.toString()).toBe(dossierText(dossier));
		expect(JSON.parse(files.get("Dossier.json")!.toString()).campaignId).toBe("42");
	});

	test("names a file that is no longer stored", async () => {
		const files = await entries(await buildDossierArchive({ ...dossier, sites: [{ ...dossier.sites[0]!, evidence: [dossier.sites[0]!.evidence[0]!] }] }, { loadArtifact: async () => undefined }));
		expect(files.get("Fehlende-Dateien.txt")!.toString()).toContain("website.mhtml: nicht mehr gespeichert");
	});
});

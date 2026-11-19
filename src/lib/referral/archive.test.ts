import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";

import { dossierArchive } from "./archive";
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
	infrastructure: [{ role: "hosting", name: "Hostinger International Ltd.", country: "CY", resources: [], contacts: ["abuse@hostinger.com"], sites: ["https://dhl-a.com/"] }],
	indicators: [{ kind: "operator_server", value: "telegram-bot:7001", links: true, evidence: { roles: ["receives_data"], backendKind: "telegram_bot", telegram: { token: "7001:AAE", chatId: "-1" } }, sites: ["https://dhl-a.com/"] }],
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
		correspondence: [],
		evidence: [
			{ artifactId: "1", name: "website.mhtml", kind: "website_mhtml", sha256: sha(mhtml), size: mhtml.length },
			{ artifactId: "2", name: "website.png", kind: "website_png", sha256: sha(png), size: png.length },
			{ artifactId: "3", name: "evidence-manifest.json", kind: "website_evidence", sha256: "0".repeat(64), size: 2 },
			{ artifactId: "4", name: "../../escape.tsr", kind: "website_evidence", sha256: sha(png), size: png.length },
		],
		indicators: [{ kind: "operator_server", value: "telegram-bot:7001", links: true, evidence: {} }],
	}],
};

async function zipEntries(archive: ReadableStream<Uint8Array>) {
	const reader = new ZipReader(new Uint8ArrayReader(await new Response(archive).bytes()));
	const result = new Map<string, { bytes: Buffer; compressionMethod: number }>();
	for (const entry of await reader.getEntries()) {
		if (entry.directory) continue;
		result.set(entry.filename, { bytes: Buffer.from(await entry.getData!(new Uint8ArrayWriter())), compressionMethod: entry.compressionMethod });
	}
	await reader.close();
	return result;
}

async function entries(archive: ReadableStream<Uint8Array>) {
	return new Map([...await zipEntries(archive)].map(([name, entry]) => [name, entry.bytes]));
}

/** A site whose evidence is `count` page captures with the given ids, sized and hashed as `blob`. */
function siteWithCaptures(count: number, blob: Buffer) {
	return { ...dossier.sites[0]!, evidence: Array.from({ length: count }, (_, index) => (
		{ artifactId: String(index + 1), name: `page-${index + 1}.mhtml`, kind: "website_mhtml", sha256: sha(blob), size: blob.length }
	)) };
}

describe("dossier archive", () => {
	test("ships the dossier and each evidence file byte for byte, under a safe name", async () => {
		const blobs = new Map<string, Buffer>([["1", mhtml], ["2", png], ["3", Buffer.from("{}")], ["4", png]]);
		const files = await entries(dossierArchive(dossier, { loadArtifact: async (id) => ({ blob: blobs.get(id.toString())! }) }));
		expect([...files.keys()].sort()).toEqual([
			"annexes/CY-Cyprus.txt",
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
		const files = await entries(dossierArchive({ ...dossier, sites: [site] }, { loadArtifact: async (id) => ({ blob: blobs.get(id.toString())! }) }));
		expect(files.get("evidence/001-dhl-a.com/website.mhtml")!.toString()).toBe(mhtml.toString());
		expect(files.get("evidence/001-dhl-a.com/website.10.mhtml")!.toString()).toBe(older.toString());
	});

	test("ships each mail with the providers byte for byte, in order, with an index; a mail without an original as its text", async () => {
		const sent = Buffer.from("From: report@phishing.support\r\nTo: abuse@hostinger.com\r\nSubject: Phishing\r\n\r\nPlease take it down.");
		const reply = Buffer.from("From: abuse@hostinger.com\r\nSubject: Re: Phishing\r\n\r\nSuspended.");
		const site = { ...dossier.sites[0]!, evidence: [], correspondence: [
			{ reportId: "70", direction: "outbound" as const, occurredAt: "2026-11-10T09:00:00.000Z", provider: "Hostinger International Ltd.", from: "report@phishing.support", to: ["abuse@hostinger.com"], subject: "Phishing", raw: { artifactId: "81", sha256: sha(sent), size: sent.length } },
			{ reportId: "70", direction: "inbound" as const, occurredAt: "2026-11-10T11:30:00.000Z", provider: "Hostinger International Ltd.", from: "abuse@hostinger.com", to: ["report@phishing.support"], subject: "Re: Phishing", raw: { artifactId: "82", sha256: sha(reply), size: reply.length } },
			{ reportId: "70", direction: "inbound" as const, occurredAt: "2026-11-11T08:00:00.000Z", provider: "Hostinger International Ltd.", from: "abuse@hostinger.com", to: [], text: "Closed." },
			{ reportId: "70", direction: "inbound" as const, occurredAt: "2026-11-12T08:00:00.000Z", provider: "Hostinger International Ltd.", to: [], raw: { artifactId: "83", sha256: "0".repeat(64), size: 3 } },
		] };
		const mails = new Map([["81", sent], ["82", reply], ["83", Buffer.from("bad")]]);
		const files = await entries(dossierArchive({ ...dossier, sites: [site] }, {
			loadArtifact: async () => undefined,
			loadMail: async (reportId, artifactId) => (reportId === 70n ? { blob: mails.get(artifactId.toString())! } : undefined),
		}));
		const folder = "evidence/001-dhl-a.com/correspondence";
		expect([...files.keys()].filter((name) => name.startsWith(folder)).sort()).toEqual([
			`${folder}/001-20261110-0900-sent-Hostinger-International-Ltd.eml`,
			`${folder}/002-20261110-1130-received-Hostinger-International-Ltd.eml`,
			`${folder}/003-20261111-0800-received-Hostinger-International-Ltd.txt`,
			`${folder}/index.txt`,
		]);
		expect(files.get(`${folder}/001-20261110-0900-sent-Hostinger-International-Ltd.eml`)!.equals(sent)).toBe(true);
		expect(files.get(`${folder}/003-20261111-0800-received-Hostinger-International-Ltd.txt`)!.toString()).toBe("Closed.");
		const index = files.get(`${folder}/index.txt`)!.toString();
		expect(index).toContain("1. 2026-11-10 09:00 UTC, sent to abuse@hostinger.com (Hostinger International Ltd.): Phishing");
		expect(index).toContain(`SHA-256 ${sha(reply)}`);
		expect(files.get("missing-files.txt")!.toString()).toContain("004-20261112-0800-received-Hostinger-International-Ltd.eml: the stored bytes do not match the recorded SHA-256");
		expect(files.get("evidence/001-dhl-a.com/analysis.txt")!.toString()).toContain("The 4 mails with the providers are in correspondence/");
	});

	test("stores formats that are compressed already and deflates the rest", async () => {
		const page = Buffer.from("<html>".padEnd(4096, "a"));
		const image = Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 7919) % 251));
		const site = { ...dossier.sites[0]!, evidence: [
			{ artifactId: "1", name: "website.mhtml", kind: "website_mhtml", sha256: sha(page), size: page.length },
			{ artifactId: "2", name: "website-stamped.PNG", kind: "website_evidence", sha256: sha(image), size: image.length },
		] };
		const blobs = new Map([["1", page], ["2", image]]);
		const files = await zipEntries(dossierArchive({ ...dossier, sites: [site] }, { loadArtifact: async (id) => ({ blob: blobs.get(id.toString())! }) }));
		const folder = "evidence/001-dhl-a.com";
		expect(files.get(`${folder}/website.mhtml`)).toEqual({ bytes: page, compressionMethod: 8 });
		expect(files.get(`${folder}/website-stamped.PNG`)).toEqual({ bytes: image, compressionMethod: 0 });
		expect(files.get("dossier.json")!.compressionMethod).toBe(8);
	});

	test("streams while it writes: the first bytes come before the evidence is loaded, and loading waits for the reader", async () => {
		const page = Buffer.alloc(256 * 1024, "a");
		const loaded: string[] = [];
		const archive = dossierArchive({ ...dossier, sites: [siteWithCaptures(40, page)] }, {
			loadArtifact: async (id) => {
				loaded.push(id.toString());
				return { blob: page };
			},
		});
		const reader = archive.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		// Nobody reads on: the writer waits instead of loading all 40 files into memory.
		await Bun.sleep(50);
		expect(loaded.length).toBeLessThan(5);
		let total = first.value!.length;
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) total += chunk.value.length;
		expect(loaded.length).toBe(40);
		expect(total).toBeGreaterThan(0);
	});

	test("ends the download as failed when a file cannot be loaded, not as a truncated archive", async () => {
		const page = Buffer.from("page");
		const archive = dossierArchive({ ...dossier, sites: [siteWithCaptures(3, page)] }, {
			loadArtifact: async (id) => {
				if (id === 2n) throw new Error("database is locked");
				return { blob: page };
			},
		});
		const errors = console.error;
		console.error = () => undefined;
		try {
			await expect(new Response(archive).bytes()).rejects.toThrow("database is locked");
		} finally {
			console.error = errors;
		}
	});

	test("stops loading files when the reader cancels the download", async () => {
		const page = Buffer.alloc(256 * 1024, "a");
		let loads = 0;
		const archive = dossierArchive({ ...dossier, sites: [siteWithCaptures(40, page)] }, { loadArtifact: async () => { loads += 1; return { blob: page }; } });
		const reader = archive.getReader();
		await reader.read();
		await reader.cancel("client went away");
		const errors = console.error;
		console.error = () => undefined;
		await Bun.sleep(50);
		console.error = errors;
		expect(loads).toBeLessThan(5);
	});

	test("names a file that is no longer stored", async () => {
		const files = await entries(dossierArchive({ ...dossier, sites: [{ ...dossier.sites[0]!, evidence: [dossier.sites[0]!.evidence[0]!] }] }, { loadArtifact: async () => undefined }));
		expect(files.get("missing-files.txt")!.toString()).toContain("website.mhtml: no longer stored");
	});
});

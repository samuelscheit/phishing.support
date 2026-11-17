import { describe, expect, test } from "bun:test";

import { countryAnnexes } from "./annex";
import type { Dossier } from "./dossier";
import { OFFENCES } from "./offences";

const site = (url: string, firstSeenAt: string) => ({
	submissionId: url,
	url,
	host: new URL(url).hostname,
	firstSeenAt,
	impersonates: ["www.dhl.de"],
	dns: { a: [], aaaa: [], cname: [], ns: [] },
	dataDestinations: [],
	reports: [],
	correspondence: [],
	evidence: [],
	indicators: [],
});

const dossier: Dossier = {
	campaignId: "42",
	generatedAt: "2026-11-17T09:00:00.000Z",
	firstSeenAt: "2026-11-10T08:00:00.000Z",
	lastSeenAt: "2026-11-12T08:00:00.000Z",
	impersonates: ["www.dhl.de"],
	dataRequested: ["Passwort"],
	requestedFields: ["email", "password"],
	sites: [site("https://dhl-a.com/", "2026-11-10T08:00:00.000Z"), site("https://dhl-b.com/", "2026-11-12T08:00:00.000Z")],
	indicators: [
		{ kind: "exfiltration_backend", value: "telegram-bot:7001", links: true, evidence: { backendKind: "telegram_bot", telegram: { chatId: "-100" } }, sites: ["https://dhl-a.com/", "https://dhl-b.com/"] },
		{ kind: "payment_receiver", value: "iban:LT121000011101001000", links: true, evidence: { receiverKind: "iban", receiver: "LT121000011101001000" }, sites: ["https://dhl-b.com/"] },
	],
	infrastructure: [
		{ role: "hosting", name: "CRYPHORA-AS - Cryphora Limited, GB", country: "GB", networkCountry: "GB", resources: ["AS219200"], contacts: ["abuse@cryphora.net"], sites: ["https://dhl-a.com/", "https://dhl-b.com/"] },
		{
			role: "hosting",
			name: "Hostinger International Ltd, Larnaca (contracting party for customers in the EU)",
			lead: { holder: { de: "Hostinger International Ltd, Larnaka", en: "Hostinger International Ltd, Larnaca (contracting party for customers in the EU)" }, country: "CY", facts: { de: "löscht nach 30 Tagen", en: "Deletes customer data 30 days after the contract ends." } },
			country: "CY",
			networkCountry: "LT",
			serverCountry: "LT",
			resources: ["2.57.91.10"],
			contacts: ["abuse@hostinger.com"],
			sites: ["https://dhl-b.com/"],
		},
		{ role: "payment", name: "IBAN LT121000011101001000", country: "LT", networkCountry: "LT", resources: [], contacts: [], sites: ["https://dhl-b.com/"] },
		{ role: "hosting", name: "living-bots.net (SYNLINQ)", country: "DE", resources: ["45.88.108.231"], contacts: [], sites: ["https://dhl-a.com/"] },
		{ role: "exfiltration", name: "collect.unknown.example", resources: [], contacts: [], sites: ["https://dhl-a.com/"] },
	],
};

describe("country annexes", () => {
	const annexes = countryAnnexes(dossier);
	const annex = (country: string) => annexes.find((candidate) => candidate.country === country)!.text;

	test("one annex per foreign state; Germany and unknown states get none", () => {
		expect(annexes.map((candidate) => candidate.fileName)).toEqual(["annexes/GB-United-Kingdom.txt", "annexes/CY-Cyprus.txt", "annexes/LT-Lithuania.txt"]);
	});

	test("names the provider, every identifier with its time, and the period of the records", () => {
		const text = annex("GB");
		expect(text).toStartWith("Annex for United Kingdom (GB): phishing campaign 42 (phishing.support)\n");
		for (const expected of [
			"Host: CRYPHORA-AS - Cryphora Limited, GB",
			"Abuse contact: abuse@cryphora.net",
			"- https://dhl-a.com/ (first seen 2026-11-10 08:00 UTC)",
			"- https://dhl-b.com/ (first seen 2026-11-12 08:00 UTC)",
			"- network AS219200",
			"at least for 2026-11-10 08:00 UTC to 2026-11-12 08:00 UTC",
			"2 phishing websites, first seen between 2026-11-10 08:00 UTC and 2026-11-12 08:00 UTC, imitated www.dhl.de and asked visitors for",
			"d. Custodian and location: CRYPHORA-AS - Cryphora Limited, GB, the United Kingdom.",
			"the part of the campaign that lies in the United Kingdom,",
			"Providers in the United Kingdom",
			"Not bound by the e-Evidence Regulation",
		]) expect(text).toContain(expected);
		// The UK is outside the EU: no production order.
		expect(text).not.toContain("European Production Order");
	});

	test("an EU state gets the production order addressed to the record holder, and the server's own location", () => {
		const text = annex("CY");
		expect(text).toContain("European Production Order (Regulation (EU) 2023/1543), pre-filled:");
		expect(text).toContain("Addressee: the designated establishment or legal representative in the EU of Hostinger International Ltd, Larnaca");
		expect(text).toContain("Deletes customer data 30 days after the contract ends.");
		expect(text).toContain("Server located in Lithuania.");
		expect(text).toContain("- address 2.57.91.10");
	});

	test("a bank account is described by its holder and transactions, with the direct complaint the state allows", () => {
		const text = annex("LT");
		expect(text).toContain("Payment receiver: IBAN LT121000011101001000");
		expect(text).toContain("The account holder's identity, the account's opening documents and its transactions, from 2026-11-12 08:00 UTC to the present.");
		expect(text).toContain("A complaint by phishing.support itself is possible: A signed report");
		expect(text).not.toContain("- https://dhl-b.com/ (first seen");
	});

	test("carries the German offences verbatim in German and English", () => {
		const text = annex("GB");
		for (const offence of OFFENCES) {
			expect(text).toContain(`Section ${offence.section} StGB – ${offence.titleEn} (${offence.titleDe})`);
			expect(text).toContain(offence.textDe);
			expect(text).toContain(offence.textEn);
		}
	});
});

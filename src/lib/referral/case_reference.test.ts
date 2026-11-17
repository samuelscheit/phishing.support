import { describe, expect, test } from "bun:test";

import { caseReferenceCandidates, caseReferenceFrom } from "./case_reference";

describe("case reference from an authority's reply", () => {
	test("reads a prosecutor's register number, with or without a label", () => {
		expect(caseReferenceFrom("Sehr geehrter Herr Scheit,\nIhre Anzeige wird hier unter dem Aktenzeichen 401 UJs 12345/26 geführt.")).toBe("401 UJs 12345/26");
		expect(caseReferenceFrom("Az.: 12 Js 345/26\nBitte stets angeben.")).toBe("12 Js 345/26");
		expect(caseReferenceFrom("In dem Ermittlungsverfahren 56 Js 7788/26 gegen Unbekannt")).toBe("56 Js 7788/26");
	});

	test("reads a police Vorgangs- or Tagebuchnummer", () => {
		expect(caseReferenceFrom("Vorgangsnummer: BY1234-005678-26/1\nMit freundlichen Grüßen")).toBe("BY1234-005678-26/1");
		expect(caseReferenceFrom("Tgb.-Nr. 105/2026/123456 – bitte bei Rückfragen angeben")).toBe("105/2026/123456");
		expect(caseReferenceFrom("Unser Zeichen: ZCB 3411 E-12/26")).toBe("ZCB 3411 E-12/26");
	});

	test("never takes our own reference quoted back", () => {
		const reply = "Ihr Zeichen: PS-00a1b2c3\nAz.: 401 UJs 12345/26";
		expect(caseReferenceCandidates(reply, ["PS-00a1b2c3"]).map((candidate) => candidate.value)).toEqual(["401 UJs 12345/26"]);
		expect(caseReferenceFrom("Ihr Zeichen 12 Js 345/26", [])).toBeUndefined();
		expect(caseReferenceFrom("Betreff: [Phishing Support] [PS-00a1b2c3] Strafanzeige", ["PS-00a1b2c3"])).toBeUndefined();
	});

	test("leaves the choice to the operator when a reply names several numbers", () => {
		const reply = "Ihre Anzeige wurde unter 401 UJs 12345/26 erfasst und an die Staatsanwaltschaft Bamberg (Az. 7 Js 999/26) abgegeben.";
		expect(caseReferenceCandidates(reply).map((candidate) => candidate.value)).toEqual(["401 UJs 12345/26", "7 Js 999/26"]);
		expect(caseReferenceFrom(reply)).toBeUndefined();
	});

	test("counts one number once even when it is labelled and repeated", () => {
		expect(caseReferenceCandidates("Aktenzeichen: 401 UJs 12345/26\n…\nBitte geben Sie das Aktenzeichen 401 UJs 12345/26 an.").map((candidate) => candidate.value)).toEqual(["401 UJs 12345/26"]);
	});

	test("finds nothing in a reply without a file number", () => {
		expect(caseReferenceCandidates("Vielen Dank für Ihre Mitteilung. Wir melden uns.")).toEqual([]);
		expect(caseReferenceCandidates("Aktenzeichen folgt.")).toEqual([]);
	});
});

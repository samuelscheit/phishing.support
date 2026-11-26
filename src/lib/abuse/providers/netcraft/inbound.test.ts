import { describe, expect, test } from "bun:test";

import { TRYLEVO_MAIL } from "../../mail/trylevo_mail.fixtures";
import { netcraftDecision, netcraftNotificationVerdict } from "./inbound";

describe("netcraftDecision", () => {
	test("its automatic analysis that found nothing, with its own sentence", () => {
		expect(netcraftDecision({ text: TRYLEVO_MAIL.netcraftNoThreat })).toEqual({
			outcome: "no_threat",
			label: "No threat found",
			sentence: "The submission you made to report.netcraft.com on 26-Nov-2026 at 18:50 UTC has been automatically analysed, and no threats were found.",
			excerpt: "Automatically analysed, and no threats were found.",
		});
		expect(netcraftNotificationVerdict(TRYLEVO_MAIL.netcraftNoThreat)).toBe("rejected");
	});

	test("a classification as malicious blocklists the site", () => {
		const text = "We've updated the classification of your submission. The URL you reported has been classified as malicious.";
		expect(netcraftDecision({ text })).toEqual({ outcome: "action_taken", label: "Blocklisted", sentence: "The URL you reported has been classified as malicious." });
		expect(netcraftNotificationVerdict(text)).toBe("acknowledged");
	});

	test("its receipt decides nothing", () => {
		expect(netcraftDecision({ text: TRYLEVO_MAIL.netcraftThanks })).toBeUndefined();
		expect(netcraftNotificationVerdict(TRYLEVO_MAIL.netcraftThanks)).toBeUndefined();
	});

	test("its API states", () => {
		expect(netcraftDecision({ state: "malicious" })).toEqual({ outcome: "action_taken", label: "Blocklisted" });
		expect(netcraftDecision({ state: "suspicious" })).toEqual({ outcome: "action_taken", label: "Blocklisted" });
		expect(netcraftDecision({ state: "no threats" })).toEqual({ outcome: "no_threat", label: "No threat found" });
		expect(netcraftDecision({ state: "processing" })).toBeUndefined();
	});
});

import { describe, expect, test } from "bun:test";

import type { PublicCampaignVisitor } from "@/lib/campaign/public_view";
import { COPY, guideSteps } from "./copy";

const google: PublicCampaignVisitor["brand"] = {
	name: "Google",
	officialUrl: "https://www.google.com/",
	domain: "google.com",
	signInHost: "accounts.google.com",
	links: { recover: "https://accounts.google.com/signin/recovery", devices: "https://myaccount.google.com/device-activity", security: "https://myaccount.google.com/security", activity: "https://myaccount.google.com/notifications" },
};

describe("guideSteps", () => {
	test("start with only opening the page, then follow the kinds in their order", () => {
		const steps = guideSteps("en", { brand: google, kinds: ["email", "password", "code", "phone"] }, "credentials");
		expect(steps.map((step) => step.kind)).toEqual(["opened", "email", "password", "code", "phone"]);
		expect(steps.map((step) => step.tone)).toEqual(["safe", "warn", "danger", "danger", "danger"]);
	});

	test("on a sign-in page a code takes over the account and the brand's validated links are offered", () => {
		const code = guideSteps("en", { brand: google, kinds: ["code"] }, "credentials")[1]!;
		expect(code.gets).toContain("sign in as you");
		expect(code.actions.map((action) => action.url).filter(Boolean)).toEqual([google!.links.devices, google!.links.recover]);
	});

	test("on a payment page the same kinds read as a payment, never as a sign-in", () => {
		for (const locale of ["en", "de"] as const) {
			const steps = guideSteps(locale, { brand: google, kinds: ["email", "code", "phone", "card"] }, "payment");
			const text = steps.flatMap((step) => [step.did, step.gets, ...step.actions.map((action) => action.text)]).join(" ");
			expect(text).not.toMatch(/sign in as you|anmelden\b.*als Sie|Wiederherstellungs-E-Mail|recovery email/i);
			expect(steps.find((step) => step.kind === "code")!.gets).toMatch(locale === "en" ? /approve a payment/ : /Zahlung/);
		}
	});

	test("without a brand nothing names one or links anywhere", () => {
		for (const locale of ["en", "de"] as const) {
			const steps = guideSteps(locale, { kinds: ["email", "password", "code", "phone"] }, "credentials");
			expect(steps.flatMap((step) => step.actions).some((action) => action.url)).toBe(false);
			expect(JSON.stringify(steps)).not.toContain("undefined");
		}
	});
});

describe("afterwardsActions", () => {
	const texts = (kinds: PublicCampaignVisitor["kinds"], basis: "credentials" | "payment" | "other") => COPY.en.afterwardsActions(google, kinds, basis).map((action) => action.text).join(" | ");

	test("account steps only where an account can be taken over", () => {
		expect(texts(["email", "password"], "credentials")).toContain("2-step verification");
		expect(texts(["card"], "payment")).not.toContain("2-step verification");
		expect(texts(["card"], "payment")).toContain("statements");
	});

	test("a code on a payment page is a bank code: money advice, no account advice", () => {
		const text = texts(["code"], "payment");
		expect(text).toContain("statements");
		expect(text).not.toContain("2-step verification");
		expect(text).not.toContain("Recent security activity");
	});

	test("the email item appears only when an email address was typed", () => {
		expect(texts(["password"], "credentials")).not.toContain("this email address");
		expect(texts(["email", "password"], "credentials")).toContain("this email address");
	});
});

describe("headline and lede", () => {
	test("say sign-in only for sign-in pages", () => {
		expect(COPY.en.lede(10, "Google", "credentials")).toContain("sign-in page");
		expect(COPY.en.lede(10, "DHL", "other")).not.toContain("sign-in");
		expect(COPY.de.lede(1, "DHL", "payment")).toMatch(/^Diese Seite kopiert DHL/);
		expect(COPY.de.headline(undefined, "other", "ignored")).toBe("Gefälschte Seiten");
		expect(COPY.en.headline(undefined, "other", "Fake parcel fee notice")).toBe("Fake parcel fee notice");
	});
});

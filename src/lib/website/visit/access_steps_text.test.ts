import { describe, expect, test } from "bun:test";
import type { WebsiteAccessStep } from "../types";
import { accessStepsNotice, accessStepsText, accessStepUrls, hasAccessSteps, withoutAccessSteps } from "./access_steps_text";

const at = "2026-11-17T10:00:00.000Z";
const login = "https://kit.example/login";
const verify = "https://kit.example/verify";
const caseUrl = "https://phishing.support/submissions/42";

const signIn: WebsiteAccessStep[] = [
	{ actor: "agent", pageUrl: login, action: "type", field: "Email", value: "jane@mail.example", at },
	{ actor: "agent", pageUrl: login, action: "type", field: "Password", value: "Kx9!q", synthetic: "password", at },
	{ actor: "agent", pageUrl: login, action: "click", field: "Sign in", at },
];
const withPerson: WebsiteAccessStep[] = [
	...signIn,
	{ actor: "human", pageUrl: verify, action: "type", field: "One-time code", value: "481516", at },
	{ actor: "human", pageUrl: verify, action: "press", value: "Enter", at },
];

describe("the access steps as text", () => {
	test("open the first page, then number each step with its field and value, naming each new page on its own line", () => {
		expect(accessStepsText(withPerson, { maxLength: 10_000, caseUrl })).toBe([
			"How to reach the content (values were made up by us, or typed by a person who took over our browser):",
			`1. Open ${login}`,
			"2. In \"Email\" enter \"jane@mail.example\"",
			"3. In \"Password\" enter \"Kx9!q\" (our made-up password)",
			"4. Click \"Sign in\"",
			`5. Continue on ${verify}`,
			"6. In \"One-time code\" enter \"481516\" [by a person]",
			"7. Press Enter [by a person]",
		].join("\n"));
		// Only our agent acted: every value is ours.
		expect(accessStepsText(signIn, { maxLength: 10_000 }).split("\n")[0]).toBe("How to reach the content (every value was made up by us and belongs to no one):");
	});

	test("word every kind of step, and a step that opens a page needs no extra line", () => {
		const steps: WebsiteAccessStep[] = [
			{ actor: "agent", pageUrl: login, action: "open", value: "https://kit.example/start", at },
			{ actor: "agent", pageUrl: "https://kit.example/start", action: "select", field: "Country", value: "Germany", at },
			{ actor: "agent", pageUrl: "https://kit.example/start", action: "click", at },
			{ actor: "agent", pageUrl: "https://kit.example/start", action: "upload", field: "ID card", at },
			{ actor: "human", pageUrl: "https://kit.example/start", action: "drag", field: "div.slider", at },
			{ actor: "human", pageUrl: "https://kit.example/start", action: "back", at },
			{ actor: "human", pageUrl: "https://kit.example/start", action: "forward", at },
			{ actor: "human", pageUrl: "https://kit.example/start", action: "reload", at },
			{ actor: "human", pageUrl: "https://kit.example/start", action: "tab", value: "https://kit.example/popup", at },
			{ actor: "agent", pageUrl: "https://kit.example/start", action: "type", value: "x\ny\"z", at },
		];
		expect(accessStepsText(steps, { maxLength: 10_000 }).split("\n").slice(1)).toEqual([
			"1. Open https://kit.example/start",
			"2. In \"Country\" choose \"Germany\"",
			"3. Click in the page",
			"4. Upload a file to \"ID card\"",
			"5. Drag \"div.slider\" [by a person]",
			"6. Go back [by a person]",
			"7. Go forward [by a person]",
			"8. Reload the page [by a person]",
			"9. Switch to the tab showing https://kit.example/popup [by a person]",
			"10. Enter \"x\\ny\\\"z\"",
		]);
	});

	test("name a made-up value as the case names it", () => {
		const typed = (synthetic: string) => accessStepsText([{ actor: "human", pageUrl: login, action: "type", field: "Card", value: "4111", synthetic, at }], { maxLength: 10_000 });
		expect(typed("cardNumber")).toContain("In \"Card\" enter \"4111\" (our made-up card number) [by a person]");
		expect(typed("iban")).toContain("(our made-up iban)");
	});

	test("cut long values and labels", () => {
		const text = accessStepsText([{ actor: "human", pageUrl: login, action: "type", field: "F".repeat(200), value: "v".repeat(1_000), at }], { maxLength: 10_000 });
		expect(text).toContain(`In "${"F".repeat(79)}…" enter "${"v".repeat(199)}…"`);
	});

	test("too long: drop steps from the middle, say how many, and point to the case page; nothing when not even one step fits", () => {
		const many: WebsiteAccessStep[] = Array.from({ length: 30 }, (_, index) => ({ actor: "agent", pageUrl: index < 15 ? login : verify, action: "click", field: `Button ${index + 1}`, at }));
		const full = accessStepsText(many, { maxLength: 100_000, caseUrl });
		expect(full).not.toContain("more steps");
		const cut = accessStepsText(many, { maxLength: 500, caseUrl });
		expect(cut.length).toBeLessThanOrEqual(500);
		const lines = cut.split("\n");
		expect(lines[1]).toBe(`1. Open ${login}`);
		expect(lines[2]).toBe("2. Click \"Button 1\"");
		expect(cut).toMatch(/\n… \d+ more steps …\n/);
		// The tail names its page again and ends with the last step, then the case page.
		expect(cut).toContain(`Continue on ${verify}`);
		expect(lines.at(-2)).toMatch(/\. Click "Button 30"$/);
		expect(lines.at(-1)).toBe(`All steps: ${caseUrl}`);
		const kept = lines.filter((line) => /Click "Button/.test(line)).length;
		expect(Number(/… (\d+) more steps/.exec(cut)![1])).toBe(30 - kept);
		// One step only, and nothing at all below that.
		const one = accessStepsText(many, { maxLength: 260, caseUrl });
		expect(one.split("\n").filter((line) => /Click "Button/.test(line))).toHaveLength(1);
		expect(accessStepsText(many, { maxLength: 60, caseUrl })).toBe("");
		// One line for fields that keep none.
		expect(accessStepsText(many, { maxLength: 500, caseUrl, inline: true })).not.toContain("\n");
	});

	test("nothing when the visit did nothing in a page", () => {
		const opened: WebsiteAccessStep[] = [{ actor: "agent", pageUrl: login, action: "open", value: login, at }, { actor: "human", pageUrl: login, action: "reload", at }];
		expect(hasAccessSteps(opened)).toBe(false);
		expect(hasAccessSteps(undefined)).toBe(false);
		expect(accessStepsText(opened, { maxLength: 10_000 })).toBe("");
		expect(accessStepsText(undefined, { maxLength: 10_000 })).toBe("");
		expect(accessStepsNotice(opened, caseUrl)).toBe("");
	});

	test("the notice says what the content takes and where the steps are", () => {
		expect(accessStepsNotice(signIn, caseUrl)).toBe(`The content shows only after entering values in the site's forms; the steps to reach it are listed at ${caseUrl}.`);
		expect(accessStepsNotice([{ actor: "agent", pageUrl: login, action: "click", field: "Continue", at }], undefined)).toBe("The content shows only after clicking through the site.");
	});

	test("the URLs the steps name, for the link check", () => {
		expect(accessStepUrls([...withPerson, { actor: "human", pageUrl: verify, action: "type", field: "Note", value: "see https://other.example/x and http://a.example", at }]))
			.toEqual([login, verify, "https://other.example/x", "http://a.example"]);
		expect(accessStepUrls(undefined)).toEqual([]);
	});

	test("a text without its block keeps every other line", () => {
		const block = accessStepsText(withPerson, { maxLength: 300, caseUrl });
		expect(block).toContain("more step");
		const text = ["Before.", block, "After.", "1. A numbered line of the text itself."].join("\n");
		expect(withoutAccessSteps(text)).toBe(["Before.", "After.", "1. A numbered line of the text itself."].join("\n"));
		expect(withoutAccessSteps(accessStepsText(withPerson, { maxLength: 10_000, inline: true }))).toBe("");
		expect(withoutAccessSteps("No steps here.")).toBe("No steps here.");
	});
});

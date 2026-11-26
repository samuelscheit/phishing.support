import { describe, expect, test } from "bun:test";
import { accessField, visitAccessSteps, type ShownPage } from "./access_steps";
import type { VisitAgentAction } from "./agent";

const pages: ShownPage[] = [
	{ url: "https://kit.example/login", shownFrom: new Date("2026-11-17T10:00:00.000Z") },
	{ url: "https://kit.example/verify", shownFrom: new Date("2026-11-17T10:01:00.000Z") },
	{ url: "https://kit.example/card", shownFrom: new Date("2026-11-17T10:03:00.000Z") },
];

let count = 0;
const agent = (kind: string, text: string, extra: Partial<VisitAgentAction> = {}): VisitAgentAction => ({ id: `${++count}`, kind, text, actor: "agent", at: "2026-11-17T10:00:30.000Z", ...extra });
const human = (kind: string, text: string, at: string, extra: Partial<VisitAgentAction> = {}): VisitAgentAction => ({ id: `p${++count}`, kind, text, actor: "human", at, ...extra });

describe("the access steps of a visit", () => {
	test("keep the agent's and the person's page actions in order, each on its page, with the field, value and made-up value", () => {
		const steps = visitAccessSteps([
			agent("thought", "I will sign in."),
			agent("type", "typed into e1; its value is now \"jane@mail.example\"", { selector: "textbox \"Email\"", value: "jane@mail.example", page: pages[0]!.url }),
			agent("type", "typed into e2; its value is now \"Kx9!q\"", { selector: "textbox \"Password\"", value: "Kx9!q", typedAs: "{{secret:password}}", page: pages[0]!.url }),
			// Reported after the click navigated, so its time lies in the next page's window: the page it names wins.
			agent("click", "clicked e3; the page navigated", { selector: "button \"Sign in\"", page: pages[0]!.url, at: "2026-11-17T10:01:05.000Z" }),
			agent("scroll", "scrolled down", { page: pages[1]!.url }),
			human("takeover", "Sam took over the browser", "2026-11-17T10:02:00.000Z"),
			human("click", "Clicked input#otp[name=otp] \"One-time code\"", "2026-11-17T10:02:01.000Z", { selector: "input#otp[name=otp] \"One-time code\"" }),
			human("type", "Typed into input#otp[name=otp] \"One-time code\"", "2026-11-17T10:02:10.000Z", { selector: "input#otp[name=otp] \"One-time code\"", value: "481516" }),
			human("key", "Pressed Enter", "2026-11-17T10:02:11.000Z"),
			human("scroll", "Scrolled down 300 px", "2026-11-17T10:02:12.000Z"),
			human("message", "Sam wrote to the agent: go on", "2026-11-17T10:02:20.000Z", { value: "go on" }),
			human("capture", "Recorded the page as a step of the visit", "2026-11-17T10:02:30.000Z"),
			human("handback", "Sam handed the browser back", "2026-11-17T10:02:40.000Z"),
			human("type", "Entered the made-up cardNumber into input[name=cc]", "2026-11-17T10:03:10.000Z", { selector: "input[name=cc]", value: "4111111111111111", typedAs: "made-up cardNumber" }),
			agent("select", "selected \"Germany\" in e9", { selector: "combobox \"Country\"", value: "Germany", page: pages[2]!.url }),
		], pages);
		expect(steps).toEqual([
			{ actor: "agent", pageUrl: pages[0]!.url, action: "type", field: "Email", value: "jane@mail.example", at: "2026-11-17T10:00:30.000Z" },
			{ actor: "agent", pageUrl: pages[0]!.url, action: "type", field: "Password", value: "Kx9!q", synthetic: "password", at: "2026-11-17T10:00:30.000Z" },
			{ actor: "agent", pageUrl: pages[0]!.url, action: "click", field: "Sign in", at: "2026-11-17T10:01:05.000Z" },
			{ actor: "human", pageUrl: pages[1]!.url, action: "click", field: "One-time code", at: "2026-11-17T10:02:01.000Z" },
			{ actor: "human", pageUrl: pages[1]!.url, action: "type", field: "One-time code", value: "481516", at: "2026-11-17T10:02:10.000Z" },
			{ actor: "human", pageUrl: pages[1]!.url, action: "press", value: "Enter", at: "2026-11-17T10:02:11.000Z" },
			{ actor: "human", pageUrl: pages[2]!.url, action: "type", field: "cc", value: "4111111111111111", synthetic: "cardNumber", at: "2026-11-17T10:03:10.000Z" },
			{ actor: "agent", pageUrl: pages[2]!.url, action: "select", field: "Country", value: "Germany", at: "2026-11-17T10:00:30.000Z" },
		]);
	});

	test("leave out refused agent actions, emptied fields and non-page actions; an agent `type … submit` also presses Enter", () => {
		const steps = visitAccessSteps([
			agent("click", "error: e4 is covered", { selector: "button \"Next\"", failed: true, page: pages[0]!.url }),
			agent("type", "typed into e1", { selector: "e1", page: pages[0]!.url }),
			human("type", "Typed into the focused field", "2026-11-17T10:00:40.000Z", { value: "" }),
			agent("wait", "waited 2 s", { page: pages[0]!.url }),
			agent("extract", "Price $42", { page: pages[0]!.url }),
			agent("type", "typed into e5; its value is now \"jane\"; pressed Enter; the page navigated", { selector: "searchbox \"Search\"", value: "jane", page: pages[0]!.url }),
			agent("press", "pressed Escape; the page navigated", { page: pages[0]!.url }),
			agent("navigate", "opened https://kit.example/start; the page navigated", { page: pages[0]!.url }),
			agent("back", "went back to https://kit.example/login", { page: pages[0]!.url }),
		], pages);
		expect(steps.map(({ action, field, value }) => [action, field, value])).toEqual([
			["type", "Search", "jane"],
			["press", undefined, "Enter"],
			["press", undefined, "Escape"],
			["open", undefined, "https://kit.example/start"],
			["back", undefined, undefined],
		]);
	});

	test("match a person's actions to the page shown at the time: before the first page, the first; without a time, the first", () => {
		const steps = visitAccessSteps([
			human("click", "Clicked a \"More\"", "2026-11-17T09:59:00.000Z", { selector: "a \"More\"" }),
			human("reload", "Reloaded https://kit.example/card", "2026-11-17T10:05:00.000Z"),
			human("tab", "Switched to the tab showing https://kit.example/popup", "2026-11-17T10:05:01.000Z"),
			{ id: "x", kind: "drag", text: "Dragged from div.slider to (10, 20)", actor: "human", selector: "div.slider" },
		], pages);
		expect(steps).toEqual([
			{ actor: "human", pageUrl: pages[0]!.url, action: "click", field: "More", at: "2026-11-17T09:59:00.000Z" },
			{ actor: "human", pageUrl: pages[2]!.url, action: "reload", at: "2026-11-17T10:05:00.000Z" },
			{ actor: "human", pageUrl: pages[2]!.url, action: "tab", value: "https://kit.example/popup", at: "2026-11-17T10:05:01.000Z" },
			{ actor: "human", pageUrl: pages[0]!.url, action: "drag", field: "div.slider", at: "" },
		]);
		expect(visitAccessSteps([human("click", "Clicked", "2026-11-17T10:00:00.000Z")], [])).toEqual([{ actor: "human", pageUrl: "", action: "click", at: "2026-11-17T10:00:00.000Z" }]);
	});

	test("name an element by its label, else its name, id or description; an agent ref names nothing", () => {
		expect(accessField("textbox \"Email\"")).toBe("Email");
		expect(accessField("input#email[name=email][type=email] \"Email address\"")).toBe("Email address");
		expect(accessField("button \"Say \\\"hi\\\"\"")).toBe("Say \"hi\"");
		expect(accessField("input#pw[name=password][type=password]")).toBe("password");
		expect(accessField("input#pw[type=password]")).toBe("pw");
		expect(accessField("textbox")).toBe("textbox");
		expect(accessField("e12")).toBeUndefined();
		expect(accessField("f2e7")).toBeUndefined();
		expect(accessField(undefined)).toBeUndefined();
	});
});

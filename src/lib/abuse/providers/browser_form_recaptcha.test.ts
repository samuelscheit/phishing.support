import { afterEach, describe, expect, test } from "bun:test";

import { BrowserFormError, openBrowserForm, setRecaptchaResponse, type BrowserFormPage } from "./browser_form";

type Field = { value: string; events: string[]; dispatchEvent(event: { type: string }): void };

/** A page that runs the helper's in-page functions here, against a scripted `document` and `fetch`. */
function page(options: { fields?: Map<string, Field> } = {}): BrowserFormPage {
	const fields = options.fields ?? new Map<string, Field>();
	return {
		goto: async () => undefined,
		evaluate: async (fn, argument) => {
			const scoped = globalThis as unknown as Record<string, unknown>;
			const saved = { document: scoped.document };
			scoped.document = {
				title: "Report abuse",
				querySelector: (selector: string) => selector === "form.f" ? {} : fields.get(selector) ?? null,
			};
			try {
				return await fn(argument);
			} finally {
				scoped.document = saved.document;
			}
		},
		close: async () => undefined,
	};
}

const open = (target: BrowserFormPage) => openBrowserForm({ provider: "Newfold", operation: "x", url: "https://example.test/", formSelector: "form.f", challengeTimeoutMs: 1_000 }, {
	acquire: async () => ({ context: { newPage: async () => target } as never, release: async () => undefined, cancel: async () => undefined }),
	now: () => 0,
	sleep: async () => undefined,
});

const originalFetch = globalThis.fetch;
const originalEvent = globalThis.Event;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.Event = originalEvent; });

describe("setRecaptchaResponse", () => {
	test("writes the token into the g-recaptcha-response textarea and tells the page", async () => {
		globalThis.Event = class { constructor(readonly type: string) {} } as never;
		const field: Field = { value: "", events: [], dispatchEvent(event) { this.events.push(event.type); } };
		const session = await open(page({ fields: new Map([['textarea[name="g-recaptcha-response"]', field]]) }));
		await setRecaptchaResponse(session as never, "03AFcWeA-" + "x".repeat(60), "Newfold");
		expect(field.value).toHaveLength(69);
		expect(field.events).toEqual(["input", "change"]);
	});

	test("a page without the field is a named page-stage error", async () => {
		const session = await open(page());
		const error = await setRecaptchaResponse(session as never, "t", "Newfold").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(BrowserFormError);
		expect(error).toMatchObject({ stage: "page", message: 'Newfold: the reCAPTCHA response field (textarea[name="g-recaptcha-response"]) is not on the page' });
	});
});

describe("postForm final URL", () => {
	test("reports the URL the page's fetch ended on after following a redirect", async () => {
		const session = await open(page());
		const seen: RequestInit[] = [];
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			seen.push(init);
			return { status: 200, url: "https://example.test/thank-you", text: async () => "<html>Thanks</html>" };
		}) as never;
		const answer = await session.postForm("https://example.test/bin/lead", [["a", "1"]]);
		expect(answer).toEqual({ status: 200, text: "<html>Thanks</html>", json: undefined, url: "https://example.test/thank-you" });
		expect(seen[0]!.redirect).toBeUndefined();
	});
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { drags, expectHumanDrag, recordingMouse, seeded } from "../../captcha/slider_test_support";
import { ProviderLoginError } from "../login_session/session";
import { ALIBABA_CLOUD_PROVIDER } from "./definition";
import { ALIBABA_SESSION_TTL_MS, alibabaCloudLoginConfig, browserReason, buildAlibabaCloudSession, consoleSecToken, loginWithContext, parseAlibabaCloudSession, passAlibabaSlider } from "./session";
import { sha256Hex } from "../../../util/hash";

describe("consoleSecToken", () => {
	test("reads the token from the console page's script", () => {
		expect(consoleSecToken(`<script>window.ALIYUN_CONSOLE_CONFIG = {\n  SEC_TOKEN: "Ak2GAMjWhLGnDwas6DsrS3",\n  FEATURE: true };</script>`)).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(consoleSecToken(`SEC_TOKEN : 'abc_DEF-12345678'`)).toBe("abc_DEF-12345678");
		expect(consoleSecToken(`{"SEC_TOKEN":"x"}`)).toBeUndefined();
	});

	test("refuses a missing, short, long or oddly-charactered token, and a longer property name", () => {
		expect(consoleSecToken("<html>login</html>")).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: ""`)).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: "short"`)).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: "${"a".repeat(129)}"`)).toBeUndefined();
		expect(consoleSecToken(`SEC_TOKEN: "${"a".repeat(128)}"`)).toBe("a".repeat(128));
		expect(consoleSecToken(`SEC_TOKEN: "abc def ghi jkl"`)).toBeUndefined();
		expect(consoleSecToken(`OLD_SEC_TOKEN: "Ak2GAMjWhLGnDwas6DsrS3"`)).toBeUndefined();
	});
});

describe("buildAlibabaCloudSession", () => {
	const cookies = [
		{ name: "cna", value: "c", domain: ".alibabacloud.com", path: "/", httpOnly: true } as never,
		{ name: "login_aliyunid_ticket", value: "ticket-1", domain: ".alibabacloud.com" },
	];

	test("needs the login ticket cookie", () => {
		expect(() => buildAlibabaCloudSession([], "Ak2GAMjWhLGnDwas6DsrS3", 0)).toThrow("missing login ticket");
		expect(() => buildAlibabaCloudSession([cookies[0]!], "Ak2GAMjWhLGnDwas6DsrS3", 0)).toThrow("missing login ticket");
		expect(() => buildAlibabaCloudSession([{ name: "login_aliyunid_ticket", value: "", domain: "x" }], "Ak2GAMjWhLGnDwas6DsrS3", 0)).toThrow("missing login ticket");
	});

	test("identifies the session by a hash of the ticket (never the ticket), keeps only name, value and domain, and expires after the bound", () => {
		const session = buildAlibabaCloudSession(cookies, "Ak2GAMjWhLGnDwas6DsrS3", 1_000);
		expect(session.id).toBe(sha256Hex("ticket-1").slice(0, 32));
		expect(session.id).not.toContain("ticket-1");
		expect(session.expiresAt).toBe(1_000 + ALIBABA_SESSION_TTL_MS);
		expect(session.secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(session.cookies).toEqual([{ name: "cna", value: "c", domain: ".alibabacloud.com" }, { name: "login_aliyunid_ticket", value: "ticket-1", domain: ".alibabacloud.com" }]);
		// A new ticket is a new session id (relogin invalidates the cached one).
		expect(buildAlibabaCloudSession([{ ...cookies[1]!, value: "ticket-2" }], "t".repeat(10), 0).id).not.toBe(session.id);
	});
});

describe("parseAlibabaCloudSession", () => {
	const valid = { id: "i", secToken: "s", expiresAt: 5, cookies: [{ name: "a", value: "b", domain: "c" }] };

	test("round-trips a stored session and drops extra fields", () => {
		expect(parseAlibabaCloudSession(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
		expect(parseAlibabaCloudSession({ ...valid, extra: 1, cookies: [{ ...valid.cookies[0], httpOnly: true }] })).toEqual(valid);
		expect(parseAlibabaCloudSession({ ...valid, cookies: [] })).toEqual({ ...valid, cookies: [] });
	});

	test("rejects every malformed shape", () => {
		for (const value of [
			undefined, null, 1, "x", [],
			{ ...valid, id: 1 }, { ...valid, secToken: undefined }, { ...valid, expiresAt: "5" }, { ...valid, cookies: "a" }, { ...valid, cookies: undefined },
			{ ...valid, cookies: [null] }, { ...valid, cookies: ["a=b"] },
			{ ...valid, cookies: [{ name: "a", value: "b" }] },
			{ ...valid, cookies: [{ name: "a", value: 2, domain: "c" }] },
			{ ...valid, cookies: [valid.cookies[0], { name: 1, value: "b", domain: "c" }] },
		]) expect(parseAlibabaCloudSession(value)).toBeUndefined();
	});
});

describe("alibabaCloudLoginConfig", () => {
	test("returns the trimmed email and the password untouched", () => {
		expect(alibabaCloudLoginConfig({ ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: "  support@phishing.support ", ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: " pw with space " })).toEqual({ email: "support@phishing.support", password: " pw with space " });
	});

	test("requires an email-shaped login and a non-empty password, naming the variable", () => {
		const password = "pw";
		for (const email of [undefined, "", "   ", "no-at-sign", "a@b", "a b@c.d", "@c.d", "a@@c.d"]) {
			expect(() => alibabaCloudLoginConfig({ ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: email, ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: password })).toThrow("ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL");
		}
		for (const bad of [undefined, ""]) expect(() => alibabaCloudLoginConfig({ ABUSE_ALIBABA_CLOUD_LOGIN_EMAIL: "a@b.c", ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD: bad })).toThrow("ABUSE_ALIBABA_CLOUD_LOGIN_PASSWORD");
	});
});

describe("browserReason", () => {
	const config = { email: "support@phishing.support", password: "s3cret-pw" };

	test("keeps the first line only, at most 160 characters", () => {
		expect(browserReason(new Error("Timeout 30000ms exceeded.\n  - waiting for locator"), config)).toBe("Timeout 30000ms exceeded.");
		expect(browserReason(new Error("x".repeat(500)), config)).toBe("x".repeat(160));
	});

	test("replaces the email and the password wherever they occur", () => {
		expect(browserReason(new Error(`fill "${config.email}" then "${config.password}", again ${config.email}`), config)).toBe(`fill "[redacted]" then "[redacted]", again [redacted]`);
		// A secret on a later line never shows.
		expect(browserReason(new Error(`failed\n${config.password}`), config)).toBe("failed");
	});

	test("accepts non-Error values and gives a reason when there is none", () => {
		expect(browserReason("plain text", config)).toBe("plain text");
		expect(browserReason(new Error(""), config)).toBe("no reason given");
		expect(browserReason(undefined, config)).toBe("undefined");
	});
});

/** The slider's selectors, as the widget answers them. */
const SLIDER_SELECTORS = { passed: ".nc_scale .btn_ok, [data-nc-lang='_yesTEXT']", refused: ".nc_wrapper .errloading", handle: ".nc_scale .btn_slide", rail: ".nc_scale" };
const HANDLE_BOX = { x: 40, y: 200, width: 42, height: 34 };
const RAIL_BOX = { x: 40, y: 200, width: 300, height: 34 };

type WidgetState = "shown" | "passed" | "refused" | "gone";
type WidgetOptions = {
	/** What a release does to the widget, by drag number (0-based). */
	outcomes?: Array<"passed" | "refused" | "gone" | "shown">;
	/** Whether clicking the error block brings the slider back. */
	refresh?: boolean;
	initial?: WidgetState;
	boxes?: { handle?: typeof HANDLE_BOX | null; rail?: typeof RAIL_BOX | null };
	onSettled?: (state: WidgetState) => void;
};

/** A frame holding Alibaba's nocaptcha widget: shown, then passed, refused or gone after a release; refused, then shown again after a refresh. */
function fakeWidgetFrame(url: string, options: WidgetOptions = {}) {
	const widget = { state: options.initial ?? "shown" as WidgetState, releases: 0, refreshClicks: 0 };
	const set = (state: WidgetState) => { widget.state = state; options.onSettled?.(state); };
	const visibleFor: Record<string, WidgetState> = { [SLIDER_SELECTORS.passed]: "passed", [SLIDER_SELECTORS.refused]: "refused", [SLIDER_SELECTORS.handle]: "shown" };
	const frame = {
		url: () => url,
		locator: (selector: string) => ({
			first: () => ({
				isVisible: async () => selector in visibleFor && widget.state === visibleFor[selector],
				boundingBox: async () => {
					if (selector === SLIDER_SELECTORS.handle) return options.boxes?.handle === null ? null : options.boxes?.handle ?? HANDLE_BOX;
					if (selector === SLIDER_SELECTORS.rail) return options.boxes?.rail === null ? null : options.boxes?.rail ?? RAIL_BOX;
					return null;
				},
				click: async () => {
					if (selector !== SLIDER_SELECTORS.refused || widget.state !== "refused") throw new Error(`click on ${selector} while ${widget.state}`);
					widget.refreshClicks++;
					if (options.refresh !== false) set("shown");
				},
			}),
		}),
	};
	const release = () => {
		if (widget.state !== "shown") return;
		set(options.outcomes?.[widget.releases] ?? "passed");
		widget.releases++;
	};
	return { frame, widget, release };
}

/** A page over fake frames; the one mouse releases into every widget that is shown. */
function fakeSliderPage(widgets: Array<ReturnType<typeof fakeWidgetFrame>>) {
	const mouse = recordingMouse(() => { for (const { release } of widgets) release(); });
	const waits: number[] = [];
	const page = { frames: () => widgets.map(({ frame }) => frame), mouse, waitForTimeout: async (ms: number) => { waits.push(ms); } };
	return { page: page as never, mouse, waits };
}

const identity = <T,>(operation: Promise<T>) => operation;
const downs = (mouse: { events: Array<{ type: string }> }) => mouse.events.filter((event) => event.type === "down").length;

/** Sleeps in the human track would take seconds per drag; run them at once. */
function instantTimers() {
	let timeout: ReturnType<typeof spyOn> | undefined;
	beforeEach(() => {
		const real = globalThis.setTimeout;
		timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => real(callback, 0)) as never);
	});
	afterEach(() => timeout?.mockRestore());
}

describe("passAlibabaSlider", () => {
	instantTimers();
	const run = (widgets: Array<ReturnType<typeof fakeWidgetFrame>>, seed = 1) => {
		const fake = fakeSliderPage(widgets);
		return { ...fake, result: passAlibabaSlider(fake.page, identity, seeded(seed)) };
	};

	test("no slider in any frame: false, and the mouse is never touched", async () => {
		const nothing = fakeWidgetFrame("https://x/a", { initial: "gone" });
		const none = run([nothing, fakeWidgetFrame("https://x/b", { initial: "gone" })]);
		expect(await none.result).toBe(false);
		expect(none.mouse.events).toEqual([]);
		const empty = run([]);
		expect(await empty.result).toBe(false);
		expect(empty.mouse.events).toEqual([]);
	});

	test("a slider in a later frame (the punish iframe) is found and dragged there", async () => {
		const main = fakeWidgetFrame("https://login/", { initial: "gone" });
		const punish = fakeWidgetFrame("https://login/punish", { outcomes: ["gone"] });
		const { result, mouse } = run([main, punish]);
		expect(await result).toBe(true);
		expect(downs(mouse)).toBe(1);
		expect(punish.widget.releases).toBe(1);
		expect(main.widget.releases).toBe(0);
		expectHumanDrag(drags(mouse.events)[0]!, HANDLE_BOX, RAIL_BOX);
	});

	test("one drag that makes the widget disappear passes", async () => {
		const { result, mouse } = run([fakeWidgetFrame("https://x", { outcomes: ["gone"] })]);
		expect(await result).toBe(true);
		expect(downs(mouse)).toBe(1);
		expect(mouse.events.at(-1)!.type).toBe("up");
	});

	test("the drag is a human track from the handle to past the rail's end, for many seeds", async () => {
		for (let seed = 1; seed <= 4; seed++) {
			const { result, mouse } = run([fakeWidgetFrame("https://x", { outcomes: ["passed"] })], seed);
			expect(await result).toBe(true);
			const all = drags(mouse.events);
			expect(all).toHaveLength(1);
			expectHumanDrag(all[0]!, HANDLE_BOX, RAIL_BOX);
		}
	}, 30_000);

	test("it presses the handle where the frame's boxes are, whatever they are", async () => {
		const handle = { x: 500, y: 640, width: 60, height: 50 };
		const rail = { x: 480, y: 640, width: 420, height: 50 };
		const { result, mouse } = run([fakeWidgetFrame("https://x", { boxes: { handle, rail } })], 3);
		expect(await result).toBe(true);
		expectHumanDrag(drags(mouse.events)[0]!, handle, rail);
	});

	test("an already shown Verified mark is a pass without any drag", async () => {
		const { result, mouse } = run([fakeWidgetFrame("https://x", { initial: "passed" })]);
		expect(await result).toBe(true);
		expect(mouse.events).toEqual([]);
	});

	test("a drag that ends on Verified passes", async () => {
		const { result, mouse } = run([fakeWidgetFrame("https://x", { outcomes: ["passed"] })]);
		expect(await result).toBe(true);
		expect(downs(mouse)).toBe(1);
	});

	test("a refused drag is refreshed by clicking the error block and dragged again until it passes", async () => {
		const widget = fakeWidgetFrame("https://x", { outcomes: ["refused", "refused", "passed"] });
		const { result, mouse } = run([widget]);
		expect(await result).toBe(true);
		expect(downs(mouse)).toBe(3);
		expect(widget.widget.refreshClicks).toBe(2);
		// Each drag is its own track.
		const all = drags(mouse.events);
		expect(all[1]!.held).not.toEqual(all[0]!.held);
		for (const drag of all) expectHumanDrag(drag, HANDLE_BOX, RAIL_BOX);
	});

	test("a refusal after the refresh also ends when the widget goes away", async () => {
		const { result, mouse } = run([fakeWidgetFrame("https://x", { outcomes: ["refused", "gone"] })]);
		expect(await result).toBe(true);
		expect(downs(mouse)).toBe(2);
	});

	test("three refusals throw after exactly three drags", async () => {
		const widget = fakeWidgetFrame("https://x", { outcomes: ["refused", "refused", "refused", "passed"] });
		const { result, mouse } = run([widget]);
		await expect(result).rejects.toThrow("Alibaba's slider check did not pass after 3 drags");
		expect(downs(mouse)).toBe(3);
		expect(widget.widget.state).toBe("refused");
	});

	test("a widget that stays put after every drag also ends after three drags", async () => {
		const { result, mouse } = run([fakeWidgetFrame("https://x", { outcomes: ["shown", "shown", "shown", "shown"] })]);
		await expect(result).rejects.toThrow("did not pass after 3 drags");
		expect(downs(mouse)).toBe(3);
	});

	test("a refresh that never changes the widget terminates instead of looping", async () => {
		const widget = fakeWidgetFrame("https://x", { initial: "refused", refresh: false });
		const { result, mouse } = run([widget]);
		await expect(result).rejects.toThrow("did not pass after 3 drags");
		expect(downs(mouse)).toBe(0);
		// A bounded number of refresh clicks, not an endless loop.
		expect(widget.widget.refreshClicks).toBeGreaterThan(0);
		expect(widget.widget.refreshClicks).toBeLessThanOrEqual(10);
	});

	test("a refresh click that fails is tolerated and the widget is read again", async () => {
		const widget = fakeWidgetFrame("https://x", { initial: "refused", refresh: false });
		const original = widget.frame.locator;
		widget.frame.locator = (selector: string) => ({ first: () => ({ ...original(selector).first(), click: async () => { throw new Error("detached"); } }) });
		await expect(run([widget]).result).rejects.toThrow("did not pass after 3 drags");
	});

	test("a missing handle or rail box throws without pressing the mouse", async () => {
		for (const boxes of [{ handle: null }, { rail: null }, { handle: null, rail: null }]) {
			const { result, mouse } = run([fakeWidgetFrame("https://x", { boxes })]);
			await expect(result).rejects.toThrow("Alibaba's slider has no box to drag");
			expect(mouse.events).toEqual([]);
		}
	});

	test("a visibility check that throws (a detached frame) counts as not visible", async () => {
		const broken = fakeWidgetFrame("https://x");
		broken.frame.locator = () => ({ first: () => ({ isVisible: async () => { throw new Error("Frame was detached"); } }) }) as never;
		const { result, mouse } = run([broken, fakeWidgetFrame("https://y", { outcomes: ["gone"] })]);
		expect(await result).toBe(true);
		expect(downs(mouse)).toBe(1);
	});

	test("every wait and drag goes through the step wrapper, so a cancel reaches it", async () => {
		const fake = fakeSliderPage([fakeWidgetFrame("https://x", { outcomes: ["gone"] })]);
		let steps = 0;
		await passAlibabaSlider(fake.page, (operation) => { steps++; return operation; }, seeded(2));
		expect(steps).toBeGreaterThanOrEqual(4);
		const canceled = fakeSliderPage([fakeWidgetFrame("https://x")]);
		await expect(passAlibabaSlider(canceled.page, () => Promise.reject(new Error("canceled")), seeded(2))).rejects.toThrow("canceled");
		expect(canceled.mouse.events).toEqual([]);
	});
});

describe("loginWithContext", () => {
	instantTimers();
	const config = { email: "support@phishing.support", password: "s3cret-pw" };
	const origin = ALIBABA_CLOUD_PROVIDER.consoleOrigin;
	const TOKEN_PAGE = `<script>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: "Ak2GAMjWhLGnDwas6DsrS3" };</script>`;

	type Calls = { frameLocators: string[]; fills: Array<[string, string]>; clicks: Array<[string, unknown]>; closed: number };

	/** A page whose login form is an iframe locator; `behaviour` can fail steps or show frames. */
	function fakeLogin(behaviour: { fill?: (selector: string, value: string) => Promise<void>; click?: () => Promise<void>; frames?: () => unknown[]; afterClick?: "console" | "stay"; verifyFrame?: unknown; mouse?: unknown } = {}) {
		const calls: Calls = { frameLocators: [], fills: [], clicks: [], closed: 0 };
		let url = "about:blank";
		const page = {
			goto: async (target: string) => { url = target; },
			frameLocator: (selector: string) => {
				calls.frameLocators.push(selector);
				return {
					locator: (inner: string) => ({
						fill: async (value: string) => { calls.fills.push([inner, value]); await behaviour.fill?.(inner, value); },
						click: async (options: unknown) => {
							calls.clicks.push([inner, options]);
							await behaviour.click?.();
							if (behaviour.afterClick !== "stay") url = `${origin}/`;
						},
					}),
				};
			},
			frames: () => behaviour.frames?.() ?? [],
			url: () => url,
			mouse: behaviour.mouse ?? recordingMouse(),
			waitForTimeout: async () => undefined,
			waitForURL: async () => undefined,
			waitForLoadState: async () => undefined,
			content: async () => TOKEN_PAGE,
			close: async () => { calls.closed += 1; },
		};
		const context = {
			newPage: async () => page,
			cookies: async () => [{ name: "login_aliyunid_ticket", value: "ticket-1", domain: ".alibabacloud.com" }],
		};
		return { context: context as never, calls, setUrl: (next: string) => { url = next; } };
	}
	/** A frame with no slider in it, as far as the slider check can tell. */
	const plainFrame = (url: string, extras: Record<string, unknown> = {}) => ({ url: () => url, locator: () => ({ first: () => ({ isVisible: async () => false }) }), ...extras });
	const MINI_LOGIN = "https://passport.alibabacloud.com/mini_login.htm";
	const VERIFY = "https://passport.alibabacloud.com/identity_verify.htm";
	/** A mini_login frame whose DOM has these error blocks; its `evaluate` runs the page function against them. */
	function miniLoginFrame(errors: Record<string, string>) {
		return plainFrame(MINI_LOGIN, {
			evaluate: async (pageFunction: () => unknown) => {
				const document = { querySelectorAll: (selector: string) => Object.entries(errors).filter(([name]) => selector.split(",").some((part) => part.trim() === `.${name}`)).map(([, innerText]) => ({ innerText })) };
				(globalThis as { document?: unknown }).document = document;
				try { return pageFunction(); } finally { delete (globalThis as { document?: unknown }).document; }
			},
		});
	}
	/** A clock that moves a minute per reading, so a login that waits ends at its deadline. */
	const tickingClock = () => { let now = 0; return () => (now += 60_000); };
	const login = (context: never, dependencies = {}) => loginWithContext(context, config, new AbortController().signal, dependencies);

	test("fills and clicks through the form frame's locators, the click without waiting for navigation, and returns the session", async () => {
		const { context, calls } = fakeLogin();
		const session = await login(context);
		expect(calls.frameLocators).toEqual(["iframe#alibaba-login-box"]);
		expect(calls.fills).toEqual([["#fm-login-id", config.email], ["#fm-login-password", config.password]]);
		expect(calls.clicks).toHaveLength(1);
		expect(calls.clicks[0]![0]).toBe("#fm-login-submit");
		expect(calls.clicks[0]![1]).toMatchObject({ noWaitAfter: true });
		expect(session).toMatchObject({ secToken: "Ak2GAMjWhLGnDwas6DsrS3", cookies: [{ name: "login_aliyunid_ticket", value: "ticket-1" }] });
		expect(calls.closed).toBe(1);
	});

	test("a browser failure names the step and the browser's reason with the typed values redacted", async () => {
		const { context, calls } = fakeLogin({ fill: async (_selector, value) => { if (value === config.password) throw new Error(`locator.fill: Timeout for ${config.email} / ${config.password}\n  call log: ...`); } });
		const failure = await login(context).catch((error) => error);
		expect(failure).toBeInstanceOf(ProviderLoginError);
		expect(failure.stage).toBe("the login form did not appear (locator.fill: Timeout for [redacted] / [redacted])");
		expect(failure.message).not.toContain(config.password);
		expect(failure.message).not.toContain(config.email);
		expect(calls.closed).toBe(1);
	});

	test("a failed click is reported at its own step", async () => {
		const { context } = fakeLogin({ click: async () => { throw new Error("Frame was detached"); } });
		const failure = await login(context).catch((error) => error);
		expect(failure.stage).toBe("the login button could not be pressed (Frame was detached)");
	});

	test("a non-empty error block in the mini_login frame ends in a refusal that does not quote the page's text", async () => {
		for (const block of ["form-error", "login-error-msg", "fm-error"]) {
			const refused = fakeLogin({ afterClick: "stay", frames: () => [miniLoginFrame({ [block]: `The account ${config.email} does not exist` })] });
			const refusal = await login(refused.context).catch((error) => error);
			expect(refusal).toBeInstanceOf(ProviderLoginError);
			expect(refusal.stage).toBe("Alibaba refused the sign-in");
			expect(refusal.message).not.toContain(config.email);
			expect(refusal.message).not.toContain("does not exist");
			expect(refused.calls.closed).toBe(1);
		}
	});

	test("empty or blank error blocks are not a refusal: the login keeps waiting until its deadline", async () => {
		const empty = fakeLogin({ afterClick: "stay", frames: () => [miniLoginFrame({ "form-error": "", "login-error-msg": "  \n\t ", "fm-error": "" })] });
		const failure = await login(empty.context, { clock: tickingClock() }).catch((error) => error);
		expect(failure).toBeInstanceOf(ProviderLoginError);
		expect(failure.stage).toBe("the login page neither opened the console nor asked for the mailed code");
	});

	test("a frame that cannot be evaluated (detached) is not a refusal either", async () => {
		const detached = plainFrame(MINI_LOGIN, { evaluate: async () => { throw new Error("Frame was detached"); } });
		const { context } = fakeLogin({ afterClick: "stay", frames: () => [detached] });
		expect((await login(context, { clock: tickingClock() }).catch((error) => error)).stage).toBe("the login page neither opened the console nor asked for the mailed code");
	});

	test("a slider shown after sign-in is dragged with a human track, then the login continues to the console", async () => {
		const mouse = recordingMouse(() => widget.release());
		const fake = fakeLogin({ afterClick: "stay", mouse, frames: () => [plainFrame(MINI_LOGIN), widget.frame] });
		const widget = fakeWidgetFrame("https://passport.alibabacloud.com/punish", { outcomes: ["gone"], onSettled: (state) => { if (state === "gone") fake.setUrl(`${origin}/`); } });
		const session = await login(fake.context, { random: seeded(5) });
		expect(session.secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(downs(mouse)).toBe(1);
		expectHumanDrag(drags(mouse.events)[0]!, HANDLE_BOX, RAIL_BOX);
		expect(fake.calls.closed).toBe(1);
	});

	test("a slider that is refused once is refreshed and dragged again, and the login still completes", async () => {
		const mouse = recordingMouse(() => widget.release());
		const fake = fakeLogin({ afterClick: "stay", mouse, frames: () => [widget.frame] });
		const widget = fakeWidgetFrame("https://x", { outcomes: ["refused", "gone"], onSettled: (state) => { if (state === "gone") fake.setUrl(`${origin}/`); } });
		await login(fake.context, { random: seeded(6) });
		expect(downs(mouse)).toBe(2);
		expect(widget.widget.refreshClicks).toBe(1);
	});

	test("a slider after sign-in that leads to the identity check continues through the mailed code", async () => {
		const actions: string[] = [];
		const mouse = recordingMouse(() => widget.release());
		let showVerify = false;
		const fake = fakeLogin({ afterClick: "stay", mouse, frames: () => [widget.frame, ...(showVerify ? [verify] : [])] });
		const verify = plainFrame(VERIFY, {
			click: async (selector: string) => { actions.push(`click ${selector}`); if (selector === ".submit button") fake.setUrl(`${origin}/`); },
			fill: async (selector: string, value: string) => { actions.push(`fill ${selector} ${value}`); },
		});
		const widget = fakeWidgetFrame("https://x", { outcomes: ["gone"], onSettled: (state) => { if (state === "gone") showVerify = true; } });
		const session = await login(fake.context, { random: seeded(7), readCode: async () => "123456" });
		expect(downs(mouse)).toBe(1);
		expect(actions).toEqual(["click #J_GetCode_Email", "fill #J_Checkcode 123456", "click .submit button"]);
		expect(session.secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
	});

	test("a slider on the identity check's code request is dragged before the code is read", async () => {
		const order: string[] = [];
		const mouse = recordingMouse(() => { order.push("drag"); widget.release(); });
		const widget = fakeWidgetFrame("https://x", { initial: "gone", outcomes: ["gone"] });
		const fake = fakeLogin({ afterClick: "stay", mouse, frames: () => [widget.frame, verify] });
		const verify = plainFrame(VERIFY, {
			click: async (selector: string) => {
				order.push(`click ${selector}`);
				if (selector === "#J_GetCode_Email") widget.widget.state = "shown";
				if (selector === ".submit button") fake.setUrl(`${origin}/`);
			},
			fill: async () => undefined,
		});
		await login(fake.context, { random: seeded(8), readCode: async () => { order.push("read"); return "1"; } });
		expect(order).toEqual(["click #J_GetCode_Email", "drag", "read", "click .submit button"]);
	});

	test("a slider that never passes ends in a login error naming the slider step", async () => {
		const mouse = recordingMouse(() => widget.release());
		const widget = fakeWidgetFrame("https://x", { outcomes: ["refused", "refused", "refused", "refused"] });
		const fake = fakeLogin({ afterClick: "stay", mouse, frames: () => [widget.frame] });
		const failure = await login(fake.context, { random: seeded(9) }).catch((error) => error);
		expect(failure).toBeInstanceOf(ProviderLoginError);
		expect(failure.stage).toBe("Alibaba's slider check did not pass (Alibaba's slider check did not pass after 3 drags)");
		expect(downs(mouse)).toBe(3);
		expect(fake.calls.closed).toBe(1);
	});

	test("a slider with no box to drag fails at the slider step, not later", async () => {
		const widget = fakeWidgetFrame("https://x", { boxes: { handle: null } });
		const fake = fakeLogin({ afterClick: "stay", frames: () => [widget.frame] });
		const failure = await login(fake.context, { random: seeded(1) }).catch((error) => error);
		expect(failure.stage).toBe("Alibaba's slider check did not pass (Alibaba's slider has no box to drag)");
	});

	test("from an unknown browser the mailed code is requested, read and entered in the identity-check frame", async () => {
		const actions: string[] = [];
		const verify = plainFrame(VERIFY, { click: async (selector: string) => { actions.push(`click ${selector}`); }, fill: async (selector: string, value: string) => { actions.push(`fill ${selector} ${value}`); } });
		let opened = false;
		const { context, calls, setUrl } = fakeLogin({ afterClick: "stay", frames: () => (opened ? [] : [verify]) });
		const readCode = async () => { opened = true; setUrl(`${origin}/`); return "346070"; };
		const session = await login(context, { readCode });
		expect(actions).toEqual(["click #J_GetCode_Email", "fill #J_Checkcode 346070", "click .submit button"]);
		expect(session.secToken).toBe("Ak2GAMjWhLGnDwas6DsrS3");
		expect(calls.closed).toBe(1);
	});

	test("a failing code read keeps its stage and the reason, redacted", async () => {
		const verify = plainFrame(VERIFY, { click: async () => undefined, fill: async () => undefined });
		const { context } = fakeLogin({ afterClick: "stay", frames: () => [verify] });
		const failure = await login(context, { readCode: async () => { throw new Error(`mailbox for ${config.email} unreachable`); } }).catch((error) => error);
		expect(failure.stage).toBe("the mailed code did not arrive (mailbox for [redacted] unreachable)");
	});
});

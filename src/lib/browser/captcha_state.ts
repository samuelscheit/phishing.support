import { OperationCanceledError } from "../abuse/worker/cancellation";
import { sleep as pause, type Sleep } from "../util/sleep";

/**
 * Browser Fabric runs a captcha solver (llm-captcha) in every browser it
 * hands out: it finds and solves Turnstile, reCAPTCHA v2, hCaptcha, Tencent's
 * TCaptcha, Aliyun's sliders, GNAME's slider, kits' drag-to-verify sliders,
 * DataDome and press-and-hold checks on its own, in any frame. Its progress is
 * published on the top document:
 *
 *   <html data-captcha-state="solving|solved|failed" data-captcha-detail="…">
 *
 * The detail names the adapter (`recaptcha`, `tcaptcha`, …) or, on `failed`,
 * the reason. Nothing in this app solves a captcha itself: it waits here.
 */
export type CaptchaState = "solving" | "solved" | "failed";

/** The field each token widget fills in its host page once it is passed; a form posts it under that name. */
const CAPTCHA_TOKEN_FIELD = {
	recaptcha: 'textarea[name="g-recaptcha-response"]',
	turnstile: 'input[name="cf-turnstile-response"]',
} as const;
export type CaptchaKind = keyof typeof CAPTCHA_TOKEN_FIELD;

type ProbeArgument = { token: string | null; widget: string | null };

/** A page whose `evaluate` runs in its top document: patchright's and puppeteer's `Page` both are one. */
export interface CaptchaPage {
	evaluate(pageFunction: (argument: ProbeArgument) => CaptchaSnapshot, argument: ProbeArgument): Promise<CaptchaSnapshot>;
}

/** The solver failed, or gave no verdict within the bound. */
export class CaptchaError extends Error {
	constructor(message: string, readonly state: CaptchaState | undefined, readonly detail: string) {
		super(message);
		this.name = "CaptchaError";
	}
}

type CaptchaSnapshot = { state: CaptchaState | undefined; detail: string; token: string; widget: boolean };

/** Runs in the page: no closures. `token` and `widget` are selectors, or null when not asked for. */
function captchaProbe(argument: ProbeArgument): CaptchaSnapshot {
	const root = document.documentElement;
	const state = root.getAttribute("data-captcha-state");
	// A widget may render only once it is in view (Turnstile does), so every look scrolls to it.
	const widget = argument.widget ? document.querySelector(argument.widget) : null;
	widget?.scrollIntoView({ block: "center" });
	const token = argument.token
		? Array.from(document.querySelectorAll(argument.token)).map((field) => ((field as HTMLInputElement).value ?? "").trim()).find(Boolean) ?? ""
		: "";
	return {
		state: state === "solving" || state === "solved" || state === "failed" ? state : undefined,
		detail: (root.getAttribute("data-captcha-detail") ?? "").slice(0, 300),
		token,
		widget: widget !== null,
	};
}

export type CaptchaWaitOptions = {
	/** Names the captcha in errors: "Tencent Cloud's slider". */
	label: string;
	timeoutMs: number;
	signal?: AbortSignal;
	pollMs?: number;
	now?: () => number;
	sleep?: Sleep;
};

const DEFAULT_POLL_MS = 250;
/** How long a page may show no captcha state before it is taken to have no challenge. */
const DEFAULT_GRACE_MS = 5_000;

/** "within 90 s (solving: tcaptcha)": the bound and the solver's last word. */
const within = (ms: number, snapshot: CaptchaSnapshot | undefined) =>
	`within ${Math.round(ms / 1000)} s (${snapshot?.state ? `${snapshot.state}${snapshot.detail ? `: ${snapshot.detail}` : ""}` : "no captcha state"})`;

/**
 * Look at the page until `settle` returns a value. A failed solve throws at
 * once; a look that throws (the page navigated mid-call) counts as nothing yet.
 */
async function watch<T>(
	page: CaptchaPage,
	argument: ProbeArgument,
	options: CaptchaWaitOptions,
	settle: (snapshot: CaptchaSnapshot, elapsedMs: number) => T | undefined | Promise<T | undefined>,
	timedOut: (last: CaptchaSnapshot | undefined) => string,
): Promise<T> {
	const now = options.now ?? Date.now;
	const wait = options.sleep ?? ((ms: number) => pause(ms, options.signal));
	const started = now();
	let last: CaptchaSnapshot | undefined;
	for (;;) {
		if (options.signal?.aborted) throw new OperationCanceledError(`Waiting for ${options.label} was canceled.`);
		const snapshot = await page.evaluate(captchaProbe, argument).catch(() => undefined);
		if (snapshot) {
			last = snapshot;
			if (snapshot.state === "failed") throw new CaptchaError(`${options.label}: the captcha solver failed${snapshot.detail ? ` (${snapshot.detail})` : ""}`, snapshot.state, snapshot.detail);
			const settled = await settle(snapshot, now() - started);
			if (settled !== undefined) return settled;
		}
		if (now() - started >= options.timeoutMs) throw new CaptchaError(`${options.label}: ${timedOut(last)}`, last?.state, last?.detail ?? "");
		await wait(options.pollMs ?? DEFAULT_POLL_MS);
	}
}

/**
 * Wait until the solver has passed the page's challenge. Resolves true once
 * the state is `solved`, false when no challenge shows up within `graceMs`;
 * throws a `CaptchaError` with the solver's reason on `failed`, or when it is
 * still solving at the deadline.
 */
export function waitForCaptchaSolved(page: CaptchaPage, options: CaptchaWaitOptions & { graceMs?: number }): Promise<boolean> {
	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	return watch(page, { token: null, widget: null }, options, (snapshot, elapsedMs) => {
		if (snapshot.state === "solved") return true;
		if (snapshot.state === undefined && elapsedMs >= graceMs) return false;
		return undefined;
	}, (last) => `the captcha was not solved ${within(options.timeoutMs, last)}`);
}

/**
 * Wait until `done()` holds: the outcome a captcha on the page guards, such
 * as the form's answer or the request it sends once the solver passed its
 * slider. A failed solve throws at once, and the deadline throws naming the
 * solver's last state; with no captcha at all this is a plain bounded wait.
 */
export async function waitForCaptchaOutcome(page: CaptchaPage, done: () => boolean | Promise<boolean>, options: CaptchaWaitOptions): Promise<void> {
	await watch(page, { token: null, widget: null }, options, async () => (await done()) ? true : undefined, (last) => `not done ${within(options.timeoutMs, last)}`);
}

/**
 * Wait until the page's `kind` widget holds a token, which the solver (or the
 * widget itself, when it passes invisibly) puts into its response field, and
 * return it. `widgetSelector` is scrolled into view on every look and tells a
 * page without the widget from one whose widget gave no token.
 */
export function waitForCaptchaToken(page: CaptchaPage, kind: CaptchaKind, options: CaptchaWaitOptions & { widgetSelector?: string; tokenSelector?: string }): Promise<string> {
	return watch(page, { token: options.tokenSelector ?? CAPTCHA_TOKEN_FIELD[kind], widget: options.widgetSelector ?? null }, options, (snapshot) => {
		return snapshot.token !== "" && snapshot.state !== "solving" ? snapshot.token : undefined;
	}, (last) => options.widgetSelector && last && !last.widget && !last.state ? `the widget (${options.widgetSelector}) is not on the page` : `no token ${within(options.timeoutMs, last)}`);
}

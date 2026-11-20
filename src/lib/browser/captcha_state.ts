import { OperationCanceledError } from "../abuse/worker/cancellation";
import { sleep as pause, type Sleep } from "../util/sleep";

/**
 * Browser Fabric runs a captcha solver (llm-captcha) in every browser it
 * hands out: it finds and solves Turnstile, reCAPTCHA v2 (with Fabric's own
 * DeathByCaptcha fallback), hCaptcha, Tencent's TCaptcha, Aliyun's sliders,
 * GNAME's slider, kits' drag-to-verify sliders, DataDome and press-and-hold
 * checks on its own, in any frame. Its progress is published on the top
 * document, with a `captcha-state` window event on each change:
 *
 *   <html data-captcha-state="solving|solved|failed" data-captcha-detail="…">
 *
 * The detail names the adapter (`recaptcha`, `tcaptcha`, …) or, on `failed`,
 * the reason. Nothing in this app solves a captcha itself: it waits here.
 *
 * The attributes stay after a challenge ends, so a wait acts only on a
 * verdict reached after it began: one already on the document (an earlier
 * challenge's `failed` or `solved`) is history, not this challenge's answer.
 */
export type CaptchaState = "solving" | "solved" | "failed";

/** The field each token widget fills in its host page once it is passed; a form posts it under that name. */
const CAPTCHA_TOKEN_FIELD = {
	recaptcha: 'textarea[name="g-recaptcha-response"]',
	turnstile: 'input[name="cf-turnstile-response"]',
} as const;
export type CaptchaKind = keyof typeof CAPTCHA_TOKEN_FIELD;

/** The solver failed, or gave no verdict within the bound. */
export class CaptchaError extends Error {
	constructor(message: string, readonly state: CaptchaState | undefined, readonly detail: string) {
		super(message);
		this.name = "CaptchaError";
	}
}

type CaptchaSnapshot = {
	state: CaptchaState | undefined;
	detail: string;
	token: string;
	widget: boolean;
	/** Names the document: a navigation starts a new one, whose state is all new. */
	document: string;
	/** How often the solver changed the state on this document since it was first looked at. */
	changes: number;
	/** A verdict that was on the document before this wait began, and so is not its answer. */
	earlier?: string;
};
type ProbeArgument = { token: string | null; widget: string | null };

/** A page whose `evaluate` runs in its top document: patchright's and puppeteer's `Page` both are one. */
export interface CaptchaPage {
	evaluate(pageFunction: (argument: ProbeArgument) => CaptchaSnapshot, argument: ProbeArgument): Promise<CaptchaSnapshot>;
}

/**
 * Runs in the page: no closures. The first look at a document starts counting
 * the solver's changes there (attribute writes and its window event; both
 * reach an isolated world too), so later looks can tell a new verdict from an
 * old one. `token` and `widget` are selectors, or null when not asked for.
 */
function captchaProbe(argument: ProbeArgument): CaptchaSnapshot {
	type Watch = { id: string; changes: number };
	const scoped = window as unknown as { __captchaWatch?: Watch };
	const root = document.documentElement;
	if (!scoped.__captchaWatch) {
		const watch: Watch = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, changes: 0 };
		scoped.__captchaWatch = watch;
		new MutationObserver((records) => { watch.changes += records.length; }).observe(root, { attributes: true, attributeFilter: ["data-captcha-state", "data-captcha-detail"] });
		window.addEventListener("captcha-state", () => { watch.changes++; });
	}
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
		document: scoped.__captchaWatch.id,
		changes: scoped.__captchaWatch.changes,
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

/** "within 90 s (solving: tcaptcha)": the bound and the solver's last word. */
const within = (ms: number, snapshot: CaptchaSnapshot | undefined) =>
	`within ${Math.round(ms / 1000)} s (${snapshot?.state ? `${snapshot.state}${snapshot.detail ? `: ${snapshot.detail}` : ""}` : "no captcha state"}${snapshot?.earlier ? `; before this wait: ${snapshot.earlier}` : ""})`;

/** One look, given up at `ms` (a hung renderer or a modal dialog never answers); undefined when there was none. */
async function look(page: CaptchaPage, argument: ProbeArgument, ms: number): Promise<CaptchaSnapshot | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(ms, 1)); });
	try {
		return await Promise.race([page.evaluate(captchaProbe, argument).catch(() => undefined), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Look at the page until `settle` returns a value. Each look's state is the
 * solver's current word on this wait: a `solved` or `failed` that was already
 * on the document when the wait began reads as no state, a `solving` always
 * counts. A fresh `failed` throws at once; a look that throws (the page
 * navigated mid-call) counts as nothing yet. At the deadline `expire` may
 * still answer from the last look, or the wait throws.
 */
async function watch<T>(
	page: CaptchaPage,
	argument: ProbeArgument,
	options: CaptchaWaitOptions,
	settle: (snapshot: CaptchaSnapshot) => T | undefined | Promise<T | undefined>,
	expire: (last: CaptchaSnapshot | undefined) => T | undefined,
	timedOut: (last: CaptchaSnapshot | undefined) => string,
): Promise<T> {
	const now = options.now ?? Date.now;
	const wait = options.sleep ?? ((ms: number) => pause(ms, options.signal));
	const started = now();
	let baseline: Pick<CaptchaSnapshot, "document" | "changes"> | undefined;
	let last: CaptchaSnapshot | undefined;
	for (;;) {
		if (options.signal?.aborted) throw new OperationCanceledError(`Waiting for ${options.label} was canceled.`);
		const seen = await look(page, argument, options.timeoutMs - (now() - started));
		if (seen) {
			baseline ??= seen;
			const fresh = seen.document !== baseline.document || seen.changes > baseline.changes;
			const snapshot: CaptchaSnapshot = fresh || seen.state === "solving" || !seen.state
				? seen
				: { ...seen, state: undefined, detail: "", earlier: `${seen.state}${seen.detail ? `: ${seen.detail}` : ""}` };
			last = snapshot;
			if (snapshot.state === "failed") throw new CaptchaError(`${options.label}: the captcha solver failed${snapshot.detail ? ` (${snapshot.detail})` : ""}`, snapshot.state, snapshot.detail);
			const settled = await settle(snapshot);
			if (settled !== undefined) return settled;
		}
		if (now() - started >= options.timeoutMs) {
			const late = expire(last);
			if (late !== undefined) return late;
			throw new CaptchaError(`${options.label}: ${timedOut(last)}`, last?.state, last?.detail ?? "");
		}
		await wait(options.pollMs ?? DEFAULT_POLL_MS);
	}
}

/**
 * Wait until `done()` holds: the outcome a captcha on the page guards, such
 * as the form's answer, the request it sends once the solver passed its
 * slider, or a button the widget unlocks. A failed solve throws at once, and
 * the deadline throws naming the solver's last state; with no captcha at all
 * this is a plain bounded wait.
 */
export async function waitForCaptchaOutcome(page: CaptchaPage, done: () => boolean | Promise<boolean>, options: CaptchaWaitOptions): Promise<void> {
	await watch(page, { token: null, widget: null }, options, async () => (await done()) ? true : undefined, () => undefined, (last) => `not done ${within(options.timeoutMs, last)}`);
}

/**
 * Wait until the page's `kind` widget holds a token, which the solver (or the
 * widget itself, when it passes invisibly) puts into its response field, and
 * return it the moment the solver is no longer working on it: a reCAPTCHA
 * token lives about two minutes. A token present at the deadline is returned
 * rather than thrown away. `widgetSelector` is scrolled into view on every
 * look and tells a page without the widget from one whose widget gave no token.
 */
export function waitForCaptchaToken(page: CaptchaPage, kind: CaptchaKind, options: CaptchaWaitOptions & { widgetSelector?: string; tokenSelector?: string }): Promise<string> {
	return watch(
		page,
		{ token: options.tokenSelector ?? CAPTCHA_TOKEN_FIELD[kind], widget: options.widgetSelector ?? null },
		options,
		(snapshot) => snapshot.token !== "" && snapshot.state !== "solving" ? snapshot.token : undefined,
		(last) => last?.token ? last.token : undefined,
		(last) => options.widgetSelector && last && !last.widget && !last.state ? `the widget (${options.widgetSelector}) is not on the page` : `no token ${within(options.timeoutMs, last)}`,
	);
}

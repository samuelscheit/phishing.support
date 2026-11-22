import { CaptchaError, waitForCaptchaToken, type CaptchaKind } from "../../../browser/captcha_state";
import { acquireFabricPatchrightSession, type FabricPatchrightSession } from "../../../browser/fabric";
import { errorSummary } from "../../../util/error_text";
import { sleep, type Sleep } from "../../../util/sleep";
import { OperationCanceledError, raceAbort, throwIfOperationCanceled } from "../../worker/cancellation";
import { boundedCleanup } from "../login_session/session";
import { parseJson } from "../../../util/values";

/**
 * A provider form that sits behind a Cloudflare managed challenge (and often a
 * captcha widget): plain HTTP cannot even load it, but a real Chrome from
 * Browser Fabric passes both on its own (its solver handles the widget,
 * `browser/captcha_state.ts`). This opens the form in such a
 * browser and lets the provider read the page and post requests from inside it,
 * so the page's cookies (`cf_clearance`), user agent and egress apply.
 *
 * Every stage that can fail names itself (`BrowserFormError.stage`), so a
 * caller that runs this before its durable marker can retry safely.
 */
export type BrowserFormStage = "browser" | "load" | "challenge" | "form" | "captcha" | "page" | "request";

export class BrowserFormError extends Error {
	constructor(readonly stage: BrowserFormStage, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "BrowserFormError";
	}
}

/**
 * What the helper needs of a browser page; patchright's `Page` satisfies it.
 * Patchright runs `evaluate` in an isolated world unless `isolatedContext` is
 * false: it shares the DOM, but none of the page's own JavaScript globals.
 */
export interface BrowserFormPage {
	goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
	evaluate<Result, Argument>(pageFunction: (argument: Argument) => Result | Promise<Result>, argument: Argument, options?: undefined, isolatedContext?: boolean): Promise<Result>;
	close(): Promise<void>;
}

export type BrowserFormFile = { filename: string; mimeType: string; base64: string };
/** One multipart part: text, or a file. A name may repeat (`upload[]`). */
export type BrowserFormField = readonly [name: string, value: string | BrowserFormFile];
/** `url` is the final URL of the page's fetch after the redirects it followed (always set by the real session). */
export type BrowserFormResponse = { status: number; text: string; json: unknown; url?: string };

export type BrowserFormOptions = {
	/** The provider's name, for errors. */
	provider: string;
	/** Names the Fabric session. */
	operation: string;
	url: string;
	/** Present once the real form has rendered, i.e. the challenge is over. */
	formSelector: string;
	signal?: AbortSignal;
	challengeTimeoutMs?: number;
	loadTimeoutMs?: number;
};

type CaptchaTokenOptions = { widgetSelector?: string; timeoutMs?: number };

export type BrowserFormSession = {
	/** The form's named inputs (hidden and honeypot ones too) whose name matches `namePattern`, as the page renders them. */
	readFormFields(namePattern: string, formSelector?: string): Promise<BrowserFormField[]>;
	/** A global of the page's own scripts, by dotted path (`dnd_cf7_uploader.ajax_nonce`); undefined when absent. */
	readGlobal(path: string): Promise<unknown>;
	/** Wait until the browser's solver has passed the page's `kind` widget (scrolled into view meanwhile) and return its token. */
	waitForCaptchaToken(kind: CaptchaKind, options?: CaptchaTokenOptions): Promise<string>;
	/** POST multipart from inside the page; the answer's status, text and parsed JSON (undefined when it is none). */
	postForm(url: string, fields: readonly BrowserFormField[], timeoutMs?: number, headers?: Readonly<Record<string, string>>): Promise<BrowserFormResponse>;
	close(): Promise<void>;
};

/** A session of a single-page form that first needs a choice (a `<select>`) before its fields render. */
export type BrowserFormChoiceSession = BrowserFormSession & {
	/** Choose `value` in the `<select>` matching `selector`, firing the events a framework's model listens to; false when the select or the option is absent. */
	selectOption(selector: string, value: string): Promise<boolean>;
};

export type BrowserFormDependencies = {
	acquire?: (signal: AbortSignal | undefined) => Promise<Pick<FabricPatchrightSession, "context" | "release" | "cancel">>;
	now?: () => number;
	sleep?: Sleep;
};

const BROWSER_FORM_DEFAULTS = {
	challengeTimeoutMs: 60_000,
	loadTimeoutMs: 45_000,
	/**
	 * Turnstile passes in about 10 s; a reCAPTCHA v2 from a datacenter IP
	 * often takes the solver's image rounds (~90 s) and then Fabric's
	 * DeathByCaptcha fallback, so `solved` can come minutes in.
	 */
	captchaTimeoutMs: 240_000,
	requestTimeoutMs: 60_000,
	pollMs: 500,
} as const;

/**
 * The widget, scrolled into view on every look so the solver can see and
 * click it: Turnstile's container (it renders only once in view) and
 * reCAPTCHA's checkbox frame (its container is often the page's own).
 */
const CAPTCHA_WIDGET: Record<CaptchaKind, string> = { turnstile: ".cf-turnstile", recaptcha: 'iframe[src*="/recaptcha/"][src*="/anchor"]' };
const CAPTCHA_NAME: Record<CaptchaKind, string> = { turnstile: "Cloudflare Turnstile", recaptcha: "reCAPTCHA" };

/**
 * `isolatedContext` for a probe that needs the page's own JavaScript state (a
 * global its scripts set, `grecaptcha`). Everything that reads or drives only
 * the DOM keeps Patchright's default isolated world, which the page's scripts
 * cannot observe.
 */
const PAGE_WORLD = false;

// The functions below run inside the page: no closures, one serializable argument.

function challengeProbe(selectors: { form: string }): { challenge: boolean; form: boolean } {
	const challenge = /just a moment|attention required|checking your browser/i.test(document.title)
		|| document.querySelector("#challenge-running, #challenge-stage, #challenge-form, #cf-challenge-running, .cf-browser-verification") !== null;
	return { challenge, form: document.querySelector(selectors.form) !== null };
}

function formFieldsProbe(argument: { form: string; pattern: string }): [string, string][] {
	const form = document.querySelector(argument.form) as HTMLFormElement | null;
	const pattern = new RegExp(argument.pattern);
	const fields: [string, string][] = [];
	for (const element of Array.from(form?.elements ?? []) as HTMLInputElement[]) {
		if (!element.name || !pattern.test(element.name) || ["file", "checkbox", "radio", "submit", "button"].includes(element.type)) continue;
		fields.push([element.name, element.value]);
	}
	return fields;
}

function globalProbe(path: string): unknown {
	let value: unknown = window;
	for (const key of path.split(".")) value = (value as Record<string, unknown> | null | undefined)?.[key];
	return value === undefined || value === null || ["string", "number", "boolean"].includes(typeof value) ? value : undefined;
}

function selectProbe(argument: { selector: string; value: string }): boolean {
	const select = document.querySelector(argument.selector) as HTMLSelectElement | null;
	if (!select || !Array.from(select.options).some((option) => option.value === argument.value)) return false;
	select.value = argument.value;
	select.dispatchEvent(new Event("input", { bubbles: true }));
	select.dispatchEvent(new Event("change", { bubbles: true }));
	return select.value === argument.value;
}

async function postProbe(argument: { url: string; fields: BrowserFormField[]; timeoutMs: number; headers?: Record<string, string> }): Promise<{ status: number; text: string; url?: string }> {
	const body = new FormData();
	for (const [name, value] of argument.fields) {
		if (typeof value === "string") {
			body.append(name, value);
			continue;
		}
		const bytes = Uint8Array.from(atob(value.base64), (character) => character.charCodeAt(0));
		body.append(name, new Blob([bytes], { type: value.mimeType }), value.filename);
	}
	const response = await fetch(argument.url, { method: "POST", credentials: "include", headers: { accept: "application/json, */*;q=0.1", ...argument.headers }, body, signal: AbortSignal.timeout(argument.timeoutMs) });
	return { status: response.status, text: await response.text(), ...(response.url ? { url: response.url } : {}) };
}

async function acquireSession(options: BrowserFormOptions): Promise<Pick<FabricPatchrightSession, "context" | "release" | "cancel">> {
	const launch = acquireFabricPatchrightSession({ operation: options.operation }, { egress: "reporting", leaseMode: "clone" });
	return raceAbort(launch, options.signal, () => {
		void launch.then((late) => late.cancel().catch(() => undefined)).catch(() => undefined);
	}, `${options.provider} browser form was canceled.`).catch((error: unknown) => {
		if (error instanceof OperationCanceledError) throw error;
		// A missing browser stays the cause: the worker reschedules it without spending the job's attempts.
		throw new BrowserFormError("browser", `${options.provider}: ${errorSummary(error)}`, { cause: error });
	});
}

/**
 * Open the form in a Fabric Chrome over the reporting egress and wait until
 * Cloudflare's challenge is passed and the form has rendered. Throws a
 * `BrowserFormError` naming the stage; the browser is released on any failure.
 */
export async function openBrowserForm(options: BrowserFormOptions, dependencies: BrowserFormDependencies = {}): Promise<BrowserFormChoiceSession & BrowserFormRequestSession & BrowserFormScripting> {
	const now = dependencies.now ?? Date.now;
	const wait = dependencies.sleep ?? ((ms: number) => sleep(ms, options.signal));
	const { provider, signal } = options;
	const canceled = `${provider} browser form was canceled.`;
	const step = <T>(operation: Promise<T>) => raceAbort(operation, signal, undefined, canceled);
	const fabric = await (dependencies.acquire ? dependencies.acquire(signal) : acquireSession(options));
	let page: BrowserFormPage | undefined;
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		if (page) await boundedCleanup(page.close());
		await boundedCleanup(fabric.release());
	};
	const run = async <T>(stage: BrowserFormStage, what: string, operation: Promise<T>): Promise<T> => {
		try {
			return await step(operation);
		} catch (error) {
			if (error instanceof OperationCanceledError || error instanceof BrowserFormError) throw error;
			throw new BrowserFormError(stage, `${provider}: ${what} (${errorSummary(error)})`);
		}
	};
	/** Poll `probe` until it returns a value; a probe that throws (the page navigated mid-call) counts as not yet. */
	const until = async <T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<{ value?: T; timedOut: boolean }> => {
		const deadline = now() + timeoutMs;
		for (;;) {
			throwIfOperationCanceled(signal, canceled);
			const value = await step(probe().catch(() => undefined));
			if (value !== undefined) return { value, timedOut: false };
			if (now() >= deadline) return { timedOut: true };
			await step(wait(BROWSER_FORM_DEFAULTS.pollMs));
		}
	};
	try {
		page = await run("browser", "the browser opened no page", fabric.context.newPage() as Promise<BrowserFormPage>);
		await run("load", "the form page did not load", page.goto(options.url, { waitUntil: "domcontentloaded", timeout: options.loadTimeoutMs ?? BROWSER_FORM_DEFAULTS.loadTimeoutMs }));
		const challengeTimeoutMs = options.challengeTimeoutMs ?? BROWSER_FORM_DEFAULTS.challengeTimeoutMs;
		let last: { challenge: boolean; form: boolean } | undefined;
		const open = page;
		const passed = await until(async () => {
			last = await open.evaluate(challengeProbe, { form: options.formSelector });
			return !last.challenge && last.form ? true : undefined;
		}, challengeTimeoutMs);
		if (passed.timedOut) {
			const seconds = `${Math.round(challengeTimeoutMs / 1000)} s`;
			throw last?.challenge === false
				? new BrowserFormError("form", `${provider}: the form (${options.formSelector}) did not appear within ${seconds}`)
				: new BrowserFormError("challenge", `${provider}: the Cloudflare challenge was not passed within ${seconds}`);
		}
	} catch (error) {
		await close();
		throw error;
	}
	const form = page;
	return {
		readFormFields: (namePattern, formSelector) => run("page", "the form fields could not be read", form.evaluate(formFieldsProbe, { form: formSelector ?? options.formSelector, pattern: namePattern })),
		readGlobal: (path) => run("page", `the page value ${path} could not be read`, form.evaluate(globalProbe, path, undefined, PAGE_WORLD)),
		waitForCaptchaToken: (kind, captcha = {}) => step(waitForCaptchaToken(form, kind, {
			label: `${provider}'s ${CAPTCHA_NAME[kind]}`,
			timeoutMs: captcha.timeoutMs ?? BROWSER_FORM_DEFAULTS.captchaTimeoutMs,
			widgetSelector: captcha.widgetSelector ?? CAPTCHA_WIDGET[kind],
			pollMs: BROWSER_FORM_DEFAULTS.pollMs,
			now,
			sleep: wait,
			...(signal ? { signal } : {}),
		})).catch((error: unknown) => {
			throw error instanceof CaptchaError ? new BrowserFormError("captcha", error.message) : error;
		}),
		selectOption: (selector, value) => run("page", `the option ${value} of ${selector} could not be chosen`, form.evaluate(selectProbe, { selector, value })),
		postForm: async (url, fields, timeoutMs = BROWSER_FORM_DEFAULTS.requestTimeoutMs, headers) => {
			const answer = await run("request", `the request to ${new URL(url).pathname} failed`, form.evaluate(postProbe, { url, fields: [...fields], timeoutMs, ...(headers ? { headers: { ...headers } } : {}) }));
			return { ...answer, json: parseJson(answer.text) };
		},
		evaluate: (pageFunction, argument) => run("page", "the page script failed", form.evaluate(pageFunction, argument, undefined, PAGE_WORLD)),
		clickAll: (selector) => run("page", `${selector} could not be clicked`, form.evaluate(clickAllProbe, selector)),
		request: async (init) => {
			const timeoutMs = init.timeoutMs ?? BROWSER_FORM_DEFAULTS.requestTimeoutMs;
			const answer = await run("request", `the request to ${new URL(init.url).pathname} failed`, form.evaluate(requestProbe, { ...init, headers: { ...init.headers }, timeoutMs }));
			return { ...answer, json: parseJson(answer.text) };
		},
		close,
	};
}

type BrowserFormRequest = {
	method: "GET" | "POST";
	url: string;
	headers?: Readonly<Record<string, string>>;
	/** Sent as the JSON body of a POST. */
	json?: unknown;
	timeoutMs?: number;
};

/** What a form needs beyond fields: clicking the page's own controls (a checkbox that reveals a captcha) and plain requests whose response headers matter (a CSRF handshake). */
export type BrowserFormRequestSession = {
	/** Click every element matching `selector` the way a pointer does; how many were clicked. */
	clickAll(selector: string): Promise<number>;
	/** A request from inside the page with its cookies; header names are lower-cased. */
	request(init: BrowserFormRequest): Promise<BrowserFormResponse & { headers: Record<string, string> }>;
};

function clickAllProbe(selector: string): number {
	const elements = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
	for (const element of elements) {
		const box = element.getBoundingClientRect();
		element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX: box.left + 4, clientY: box.top + 4 }));
	}
	return elements.length;
}

async function requestProbe(argument: BrowserFormRequest & { timeoutMs: number }): Promise<{ status: number; text: string; headers: Record<string, string> }> {
	const headers: Record<string, string> = { accept: "application/json, text/plain, */*", ...argument.headers };
	if (argument.json !== undefined) headers["content-type"] = "application/json";
	const response = await fetch(argument.url, {
		method: argument.method,
		credentials: "include",
		headers,
		...(argument.json !== undefined ? { body: JSON.stringify(argument.json) } : {}),
		signal: AbortSignal.timeout(argument.timeoutMs),
	});
	const received: Record<string, string> = {};
	response.headers.forEach((value, name) => { received[name.toLowerCase()] = value; });
	return { status: response.status, text: await response.text(), headers: received };
}

/**
 * Generic in-page script for forms whose protections the fixed helpers do not
 * cover (an invisible reCAPTCHA token, a cookie banner, a request with its own
 * headers). `pageFunction` runs inside the page, in its own JavaScript world
 * (its globals, such as `grecaptcha`, are visible): no closures, one
 * serializable argument and result. A failure is a `BrowserFormError` of
 * stage `page`.
 */
export type BrowserFormScripting = {
	evaluate<Result, Argument>(pageFunction: (argument: Argument) => Result | Promise<Result>, argument: Argument): Promise<Result>;
};

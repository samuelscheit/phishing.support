import type { Page } from "patchright";

import { waitForCaptchaOutcome } from "../../../browser/captcha_state";
import { acquireFabricPatchrightSession, type FabricPatchrightSession } from "../../../browser/fabric";
import { errorSummary } from "../../../util/error_text";
import { OperationCanceledError, raceAbort } from "../../worker/cancellation";
import { boundedCleanup } from "../login_session/session";
import { TENCENT_PROVIDER } from "./definition";

/** What the form's fields take; the values of a verified draft. */
export type TencentFormInput = {
	domain: string;
	url: string;
	infringedUrl?: string;
	category: string;
	describe: string;
	name: string;
	email: string;
	countryName: string;
	screenshot: { filename: string; bytes: Buffer };
};

/** The form's own filing request, caught on its way out. */
export type TencentCapturedRequest = { url: string; method: string; contentType: string; body: string };

type TencentFormResponse = { status: number; text: string };

/**
 * A browser page on Tencent's DNS-abuse form. `captureRequest` does everything
 * that cannot file anything; `send` is the one request that does.
 */
export type TencentFormSession = {
	/** Fill the form, let the browser's solver pass the slider, and catch (and abort) the request the page then makes. */
	captureRequest(input: TencentFormInput): Promise<TencentCapturedRequest>;
	/** Send the caught request once from inside the page: same IP, same cookies. */
	send(request: TencentCapturedRequest): Promise<TencentFormResponse>;
	close(): Promise<void>;
};

const FORM = {
	ready: 'input[name="domain"]',
	/**
	 * Tencent's EEA cookie dialog, fixed over the bottom of the page: it covers
	 * the privacy checkboxes (a click there lands on it; seen live 2026-11-21)
	 * and the slider's popup. It is hidden for the whole document, as it may
	 * also come late. None of its buttons is pressed: declining opens a
	 * confirmation dialog of its own that covers the form's dropdowns.
	 */
	cookieBanner: ".eea-cookie-tip-container",
	categoryDropdown: ".tea-dropdown__header",
	countryDropdown: ".dropdown-link",
	countryOption: ".dropdown-menu li a",
	submit: 'button[type="submit"]',
	loadTimeoutMs: 45_000,
	stepTimeoutMs: 15_000,
	requestTimeoutMs: 60_000,
	/** From the submit click to the form's filing request: the slider showing up, the solver passing it (puzzles it refreshes included), the ticket. */
	sliderTimeoutMs: 150_000,
} as const;

/** The only request that can file a report; the page's route aborts it until `send` lifts the guard. */
const FILING_ROUTE = "**/reportDsaPlatform/createDomainReport*";

type Acquired = Pick<FabricPatchrightSession, "context" | "release" | "cancel">;
export type TencentBrowserDependencies = { acquire?: (signal: AbortSignal | undefined) => Promise<Acquired> };

async function acquire(signal: AbortSignal | undefined): Promise<Acquired> {
	const launch = acquireFabricPatchrightSession({ operation: "tencent-dns-abuse" }, { egress: "reporting", leaseMode: "clone" });
	return raceAbort(launch, signal, () => {
		void launch.then((late) => late.cancel().catch(() => undefined)).catch(() => undefined);
	}, "Tencent Cloud browser form was canceled.");
}

/** Runs inside the page: no closures. */
async function sendProbe(argument: { url: string; contentType: string; body: string; timeoutMs: number }): Promise<TencentFormResponse> {
	const response = await fetch(argument.url, {
		method: "POST",
		credentials: "include",
		headers: { accept: "application/json, text/plain, */*", "content-type": argument.contentType },
		body: argument.body,
		signal: AbortSignal.timeout(argument.timeoutMs),
	});
	return { status: response.status, text: await response.text() };
}

async function hideCookieBanner(page: Page): Promise<void> {
	await page.addStyleTag({ content: `${FORM.cookieBanner} { display: none !important; }` });
}

async function fillForm(page: Page, input: TencentFormInput): Promise<void> {
	const timeout = FORM.stepTimeoutMs;
	await page.waitForSelector(FORM.ready, { timeout: FORM.loadTimeoutMs });
	await hideCookieBanner(page);
	await page.fill('input[name="domain"]', input.domain, { timeout });
	await page.fill('input[name="url"]', input.url, { timeout });
	if (input.infringedUrl) await page.fill('input[name="infringedUrl"]', input.infringedUrl, { timeout });
	await page.locator(FORM.categoryDropdown).click({ timeout });
	await page.locator(`label[name="${input.category}"]`).click({ timeout });
	await page.fill('textarea[name="describe"]', input.describe, { timeout });
	await page.setInputFiles('input[name="file"]', { name: input.screenshot.filename, mimeType: "image/png", buffer: input.screenshot.bytes }, { timeout });
	await page.fill('input[name="name"]', input.name, { timeout });
	await page.fill('input[name="email"]', input.email, { timeout });
	await page.locator(FORM.countryDropdown).click({ timeout });
	await page.locator(FORM.countryOption, { hasText: new RegExp(`^${input.countryName}$`) }).click({ timeout });
	for (const name of ["privacyCheckbox1", "privacyCheckbox2"]) await page.locator(`input[name="${name}"]`).check({ force: true, timeout });
}

/**
 * Open Tencent's DNS-abuse form in a Fabric Chrome over the direct egress.
 * The filing request is aborted by a route installed before anything is
 * submitted, so nothing the preflight does can file a report. The submit
 * click opens Tencent's slide puzzle, which the browser's own solver passes;
 * the form then makes its filing request, ticket included.
 */
export async function openTencentForm(signal?: AbortSignal, dependencies: TencentBrowserDependencies = {}): Promise<TencentFormSession> {
	const fabric = await (dependencies.acquire ?? acquire)(signal);
	let page: Page | undefined;
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		if (page) await boundedCleanup(page.close());
		await boundedCleanup(fabric.release());
	};
	try {
		page = await raceAbort(fabric.context.newPage(), signal, undefined, "Tencent Cloud browser form was canceled.");
	} catch (error) {
		await close();
		throw error;
	}
	const form = page;
	let guarded = true;
	let captured: TencentCapturedRequest | undefined;
	await form.route(FILING_ROUTE, async (route) => {
		const request = route.request();
		// Only the first request is kept, and none is ever let through while guarded.
		if (guarded && !captured) captured = { url: request.url(), method: request.method(), contentType: request.headers()["content-type"] ?? "application/json", body: request.postData() ?? "" };
		await route.abort("blockedbyclient");
	});
	return {
		captureRequest: async (input) => {
			try {
				await raceAbort((async () => {
					await form.goto(TENCENT_PROVIDER.reportPageUrl, { waitUntil: "domcontentloaded", timeout: FORM.loadTimeoutMs });
					await fillForm(form, input);
					await form.locator(FORM.submit).click({ timeout: FORM.stepTimeoutMs });
					// The puzzle the click opens is the solver's: wait for the request the form sends once it passes.
					await waitForCaptchaOutcome(form, () => captured !== undefined, { label: "Tencent Cloud's slider", timeoutMs: FORM.sliderTimeoutMs, ...(signal ? { signal } : {}) });
				})(), signal, undefined, "Tencent Cloud browser form was canceled.");
			} catch (error) {
				if (error instanceof OperationCanceledError) throw error;
				throw new Error(`Tencent Cloud form could not be prepared: ${errorSummary(error)}`);
			}
			if (!captured) throw new Error("Tencent Cloud form made no filing request.");
			return captured;
		},
		send: async (request) => {
			guarded = false;
			await form.unroute(FILING_ROUTE);
			return raceAbort(form.evaluate(sendProbe, { url: request.url, contentType: request.contentType, body: request.body, timeoutMs: FORM.requestTimeoutMs }), signal, undefined, "Tencent Cloud browser form was canceled.");
		},
		close,
	};
}

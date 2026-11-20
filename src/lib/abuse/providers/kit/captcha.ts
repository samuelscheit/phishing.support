import type { CaptchaKind } from "../../../browser/captcha_state";
import { openBrowserForm, type BrowserFormDependencies } from "./browser_form";

export type CaptchaTokenPage = {
	/** The provider's name, for errors. */
	provider: string;
	/** Names the Fabric session. */
	operation: string;
	/** The provider's own form page, which renders the widget. */
	url: string;
	/** Present once the page has rendered past any Cloudflare check. */
	formSelector: string;
	kind: CaptchaKind;
	widgetSelector?: string;
	timeoutMs?: number;
};

/**
 * A token for a provider that files over plain HTTP but gates a step on a
 * reCAPTCHA or Turnstile widget: open the provider's form page in a Fabric
 * Chrome on the reporting egress, let the browser's solver pass the widget,
 * read the token from its response field and release the browser. It files
 * nothing, so it runs in a preflight before the durable marker; the browser
 * is released on every path. A reCAPTCHA token lives about two minutes, so
 * the request that carries it must follow at once.
 */
export async function captchaTokenFromPage(page: CaptchaTokenPage, signal: AbortSignal | undefined, dependencies: BrowserFormDependencies = {}): Promise<string> {
	const session = await openBrowserForm({ provider: page.provider, operation: page.operation, url: page.url, formSelector: page.formSelector, ...(signal ? { signal } : {}) }, dependencies);
	try {
		return await session.waitForCaptchaToken(page.kind, {
			...(page.widgetSelector ? { widgetSelector: page.widgetSelector } : {}),
			...(page.timeoutMs ? { timeoutMs: page.timeoutMs } : {}),
		});
	} finally {
		await session.close();
	}
}

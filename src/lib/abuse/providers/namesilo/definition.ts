import { serviceIdentity } from "../../../network/service_identity";
import { definePinned } from "../kit/pin";

/**
 * Code-owned contract for NameSilo's dedicated phishing form. Runtime
 * credentials, CSRF tokens, cookies, and CAPTCHA solutions are deliberately
 * excluded from the route-pinned definition and durable provider payload.
 */
export const NAMESILO_PROVIDER = definePinned({
	key: "namesilo",
	displayName: "NameSilo Phishing Report",
	version: "2026-11-22.1",
	exactMailboxes: ["abuse@namesilo.com", "support@namesilo.com"],
	supplemental: false,
	reportPageUrl: "https://www.namesilo.com/phishing-report",
	tokenUrl: "https://www.namesilo.com/public/api/token",
	submissionUrl: "https://www.namesilo.com/support/v2/api/phishing-report",
	/**
	 * The reCAPTCHA v2 of `reportPageUrl`, passed by the browser's own solver
	 * on that page; the page counts as rendered once the widget has put its
	 * response field into it.
	 */
	captcha: { solver: "browser_fabric" as const, kind: "recaptcha" as const, formSelector: 'textarea[name="g-recaptcha-response"]' },
	evidence: {
		acceptedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/tiff"] as const,
		maximumBytes: 10 * 1_000_000,
	},
	maximumReportLength: 5_000,
	reporter: {
		email: serviceIdentity.mailbox,
	},
});


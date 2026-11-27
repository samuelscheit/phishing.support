import { FABRIC_EGRESS_LABEL, isBrowserUnavailable, type FabricEgress } from "../../browser/fabric";
import { isAbortError } from "../../util/abort";
import { errorText } from "../../util/error_text";

/**
 * The browser service failed rather than the site: Fabric's relay was full or
 * unreachable, the CDP connection dropped, or the leased browser closed under
 * the capture. These say nothing about the site and are worth retrying later.
 */
export class BrowserInfrastructureError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "BrowserInfrastructureError";
	}
}

const BROWSER_INFRASTRUCTURE_FAILURE = /Expected 101 status code|Unexpected server response: (?:502|503|504)|ECONNREFUSED|ECONNRESET|socket hang up|Target closed|Session closed|Connection closed|Protocol error|browser has disconnected|Navigating frame was detached|Attempted to use detached Frame|Execution context was destroyed|Browser Fabric (?:transport request failed|session ended)/i;

/** Every route failed to reach the site; its reasons may quote a route's own browser trouble. */
export class WebsiteCaptureFailedError extends Error {
	constructor(readonly failures: readonly WebsiteUnreachableError[]) {
		super(`Failed to load page: ${failures.map((error) => error.message).join("; ")}`);
		this.name = "WebsiteCaptureFailedError";
	}
}

/**
 * The site's host name is gone from DNS (confirmed NXDOMAIN): the site is
 * offline, and visiting it again cannot change that.
 */
export class WebsiteHostOfflineError extends Error {
	readonly retryable = false as const;

	constructor(readonly hostname: string, options?: { cause?: unknown }) {
		super(`${hostname} no longer resolves in DNS (offline)`, options);
		this.name = "WebsiteHostOfflineError";
	}
}

/**
 * Whether a capture failure came from the browser service rather than the
 * site. A verdict about the site and a cancelled capture never are.
 */
export function isBrowserInfrastructureFailure(error: unknown): boolean {
	// A missing browser (`BrowserUnavailableError`) belongs to the worker's outage pause, not a local capture retry loop.
	if (error instanceof WebsiteUnreachableError || error instanceof WebsiteCaptureFailedError || error instanceof WebsiteHostOfflineError || isBrowserUnavailable(error) || isAbortError(error)) return false;
	return error instanceof BrowserInfrastructureError || BROWSER_INFRASTRUCTURE_FAILURE.test(errorText(error));
}

/**
 * The site's main document could not be loaded over one egress route: the
 * navigation failed, or it answered with an HTTP error that did not resolve itself.
 */
export class WebsiteUnreachableError extends Error {
	constructor(readonly egress: FabricEgress, readonly reason: string) {
		super(`${reason} via ${FABRIC_EGRESS_LABEL[egress]}`);
		this.name = "WebsiteUnreachableError";
	}
}


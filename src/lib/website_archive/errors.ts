import { FABRIC_EGRESS_LABEL, type FabricEgress } from "../browser/fabric";
import { errorText } from "../error_text";

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

const BROWSER_INFRASTRUCTURE_FAILURE = /Expected 101 status code|Unexpected server response: (?:502|503|504)|ECONNREFUSED|ECONNRESET|socket hang up|Target closed|Session closed|Connection closed|Protocol error|browser has disconnected|Navigating frame was detached|Execution context was destroyed|Browser Fabric (?:transport request failed|session ended)/i;

/** Every route failed to reach the site; its reasons may quote a route's own browser trouble. */
export class WebsiteCaptureFailedError extends Error {
	constructor(readonly failures: readonly WebsiteUnreachableError[]) {
		super(`Failed to load page: ${failures.map((error) => error.message).join("; ")}`);
		this.name = "WebsiteCaptureFailedError";
	}
}

/** Whether a capture failure came from the browser service rather than the site. */
export function isBrowserInfrastructureFailure(error: unknown): boolean {
	if (error instanceof WebsiteUnreachableError || error instanceof WebsiteCaptureFailedError) return false;
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


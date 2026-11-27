import { describe, expect, test } from "bun:test";

import { BrowserUnavailableError } from "../../browser/fabric";
import { BrowserInfrastructureError, isBrowserInfrastructureFailure, WebsiteCaptureFailedError, WebsiteHostOfflineError, WebsiteUnreachableError } from "./errors";

describe("WebsiteHostOfflineError", () => {
	test("is a final, readable verdict about the site", () => {
		const offline = new WebsiteHostOfflineError("login-paypa1.example", { cause: new Error("net::ERR_TUNNEL_CONNECTION_FAILED") });
		expect(offline.message).toBe("login-paypa1.example no longer resolves in DNS (offline)");
		expect(offline.hostname).toBe("login-paypa1.example");
		expect(offline.retryable).toBe(false);
		expect(offline.name).toBe("WebsiteHostOfflineError");
		expect(offline).toBeInstanceOf(Error);
	});
});

describe("isBrowserInfrastructureFailure", () => {
	test("blames the browser service for its own failures, but leaves BrowserUnavailableError to the worker outage pause", () => {
		expect(isBrowserInfrastructureFailure(new BrowserInfrastructureError("relay full"))).toBeTrue();
		expect(isBrowserInfrastructureFailure(new Error("Protocol error (Page.navigate): Target closed"))).toBeTrue();
		expect(isBrowserInfrastructureFailure(new Error("Browser Fabric transport request failed (connect ECONNREFUSED)"))).toBeTrue();
		expect(isBrowserInfrastructureFailure(new BrowserUnavailableError(new Error("Expected 101 status code")))).toBeFalse();
		expect(isBrowserInfrastructureFailure(new BrowserUnavailableError(new Error("Browser Fabric transport request failed (ECONNREFUSED)")))).toBeFalse();
	});

	test("never blames it for a verdict about the site, even one quoting browser trouble", () => {
		expect(isBrowserInfrastructureFailure(new WebsiteHostOfflineError("gone.example"))).toBeFalse();
		expect(isBrowserInfrastructureFailure(new WebsiteUnreachableError("phishing", "net::ERR_CONNECTION_RESET (Target closed)"))).toBeFalse();
		expect(isBrowserInfrastructureFailure(new WebsiteCaptureFailedError([new WebsiteUnreachableError("phishing", "Session closed")]))).toBeFalse();
	});

	test("never blames it for a cancelled capture, whatever the cancellation left behind", () => {
		expect(isBrowserInfrastructureFailure(new DOMException("This operation was aborted", "AbortError"))).toBeFalse();
		expect(isBrowserInfrastructureFailure(new DOMException("The operation timed out.", "TimeoutError"))).toBeFalse();
		expect(isBrowserInfrastructureFailure(new Error("Protocol error: Target closed", { cause: new DOMException("aborted", "AbortError") }))).toBeFalse();
	});
});

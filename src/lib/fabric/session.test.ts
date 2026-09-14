import { expect, test } from "bun:test";

import {
	fabricBrowserSessionIdFromProviderPayload,
	isFabricBrowserSessionId,
} from "./session";

test("Fabric browser lifecycle payloads retain only a valid opaque session ID", () => {
	expect(isFabricBrowserSessionId("browser-session_valid_123")).toBeTrue();
	expect(isFabricBrowserSessionId("browser-session_bad?cap=secret")).toBeFalse();
	expect(isFabricBrowserSessionId("wss://fabric.example/v1/cdp/browser-session_valid")).toBeFalse();
	expect(fabricBrowserSessionIdFromProviderPayload({
		__fabricBrowserSessionId: "browser-session_valid_123",
		cdpEndpoint: "wss://fabric.example/v1/cdp/browser-session_valid_123?cap=secret",
	})).toBe("browser-session_valid_123");
	expect(fabricBrowserSessionIdFromProviderPayload({
		__fabricBrowserSessionId: "browser-session_bad?cap=secret",
	})).toBeUndefined();
});

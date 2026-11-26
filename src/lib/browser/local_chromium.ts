import { homedir } from "node:os";

/** A headless Chromium on this machine, for tests and development fixtures (`PHISHING_TEST_CHROMIUM` overrides). */
export const localChromium = process.env.PHISHING_TEST_CHROMIUM
	?? `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

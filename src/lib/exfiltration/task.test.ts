import { describe, expect, test } from "bun:test";

import { buildExfiltrationProbeTask, MAX_FORM_SUBMISSIONS, probeMaxSteps } from "./task";
import type { ExfiltrationCanaries } from "./types";

const canaries: ExfiltrationCanaries = {
	marker: "psprobe_0123456789abcdef",
	email: "probe.0123456789abcdef@probe-canary.invalid",
	password: "A9!psprobe_0123456789abcdef!qZ",
	phone: "+15550100123",
	cardNumber: "4242424242424242",
	oneTimeCode: "123456",
};

describe("exfiltration probe task scope", () => {
	test("lets the browser guardian clear reCAPTCHA v2 and Turnstile, and forbids the agent from clicking them", () => {
		const prompt = buildExfiltrationProbeTask("https://phish.example/", canaries, 80).prompt;
		expect(prompt).toContain("reCAPTCHA v2 or Cloudflare Turnstile checkbox is cleared automatically by the browser's guardian");
		expect(prompt).toContain("do not click it yourself");
	});

	test("stops at a challenge that remains after waiting, such as hCaptcha or an image puzzle", () => {
		const prompt = buildExfiltrationProbeTask("https://phish.example/", canaries, 80).prompt;
		expect(prompt).toContain("still present after waiting (such as hCaptcha or an image puzzle)");
	});

	test("never tells the agent to solve a challenge itself", () => {
		const prompt = buildExfiltrationProbeTask("https://phish.example/", canaries, 80).prompt;
		expect(prompt).not.toMatch(/\bsolve (?:the |a |any )?(?:captcha|challenge)/i);
	});

	test("keeps the submission cap and the synthetic-only rule", () => {
		const prompt = buildExfiltrationProbeTask("https://phish.example/", canaries, 80).prompt;
		expect(prompt).toContain(`Make at most ${MAX_FORM_SUBMISSIONS} form submissions in total.`);
		expect(prompt).toContain("Never enter, request, or retrieve real personal data");
		expect(MAX_FORM_SUBMISSIONS).toBe(3);
	});

	test("forbids real logins, permissions, extensions and installers", () => {
		const prompt = buildExfiltrationProbeTask("https://phish.example/", canaries, 80).prompt;
		expect(prompt).toContain("approve a real login or second factor");
		expect(prompt).toContain("install extensions");
		expect(prompt).toContain("accept a dialog that installs software");
	});

	test("never asks the agent to open, run, or enter data into a downloaded file", () => {
		const prompt = buildExfiltrationProbeTask("https://phish.example/", canaries, 80).prompt;
		expect(prompt).toContain("Never open, run, install, execute, extract, or interact with any downloaded file");
	});

	test("uses only the synthetic canary identities", () => {
		const task = buildExfiltrationProbeTask("https://phish.example/", canaries, 80);
		expect(task.prompt).toContain(canaries.email);
		expect(task.prompt).toContain(canaries.password);
	});

	test("rejects a credential-bearing or non-HTTP page URL", () => {
		expect(() => buildExfiltrationProbeTask("https://user:pass@phish.example/", canaries, 80)).toThrow("credential-free HTTP URL");
		expect(() => buildExfiltrationProbeTask("file:///etc/passwd", canaries, 80)).toThrow("credential-free HTTP URL");
	});
});

describe("probe step limit", () => {
	test("defaults when unset and rejects malformed or out-of-range values", () => {
		expect(probeMaxSteps(undefined)).toBe(80);
		expect(probeMaxSteps("120")).toBe(120);
		expect(() => probeMaxSteps("abc")).toThrow("whole number");
		expect(() => probeMaxSteps("0")).toThrow("from 1 to 200");
		expect(() => probeMaxSteps("201")).toThrow("from 1 to 200");
	});
});

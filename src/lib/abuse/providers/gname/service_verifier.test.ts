import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { classifyGnameServiceEvidence } from "./service_verifier";

const environmentNames = ["ABUSE_VERIFIER_ENABLED", "ABUSE_VERIFIER_ENDPOINT"] as const;
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));

const capture = {
	url: "https://login.example.com/collect",
	screenshot: Buffer.from("fresh screenshot"),
	pageText: "A credential-harvesting page.",
	pageTitle: "Example login",
};

beforeEach(() => {
	process.env.ABUSE_VERIFIER_ENABLED = "true";
	process.env.ABUSE_VERIFIER_ENDPOINT = "https://verifier.example.com/v1/classify";
});

afterAll(() => {
	for (const name of environmentNames) {
		const value = originalEnvironment[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("GNAME configured service-verifier network boundary", () => {
	test("validates the configured public HTTPS endpoint before DNS or fetch, and forbids redirects", async () => {
		let dnsCalls = 0;
		let fetchCalls = 0;
		process.env.ABUSE_VERIFIER_ENDPOINT = "https://127.0.0.1/internal";
		await expect(classifyGnameServiceEvidence(capture, {
			assertPublicHost: async () => { dnsCalls += 1; },
			fetch: async () => { fetchCalls += 1; return new Response(); },
		})).rejects.toThrow("public network address");
		expect({ dnsCalls, fetchCalls }).toEqual({ dnsCalls: 0, fetchCalls: 0 });

		process.env.ABUSE_VERIFIER_ENDPOINT = "https://verifier.example.com/v1/classify";
		const redirects: URL[] = [];
		await expect(classifyGnameServiceEvidence(capture, {
			assertPublicHost: async (hostname) => expect(hostname).toBe("verifier.example.com"),
			fetch: async (url, init) => {
				redirects.push(url);
				expect(init).toMatchObject({ method: "POST", redirect: "manual" });
				return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/internal" } });
			},
		})).rejects.toThrow("redirected to an unapproved destination");
		expect(redirects.map(String)).toEqual(["https://verifier.example.com/v1/classify"]);
	});

	test("accepts only bounded, valid verifier output from the validated endpoint", async () => {
		const hosts: string[] = [];
		const result = await classifyGnameServiceEvidence(capture, {
			assertPublicHost: async (hostname) => { hosts.push(hostname); },
			fetch: async () => new Response(JSON.stringify({ phishing: true, confidence: 0.94, rationale: "Credential collection matches the verified campaign." }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		});
		expect(hosts).toEqual(["verifier.example.com"]);
		expect(result).toEqual({ phishing: true, confidence: 0.94, rationale: "Credential collection matches the verified campaign." });

		const invalidConfidence = await classifyGnameServiceEvidence(capture, {
			assertPublicHost: async () => undefined,
			fetch: async () => new Response(JSON.stringify({ phishing: true, confidence: 4 }), { status: 200 }),
		});
		expect(invalidConfidence).toEqual({ phishing: false, confidence: 0, rationale: undefined });
	});
});

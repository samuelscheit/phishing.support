import { afterAll, describe, expect, test } from "bun:test";

import { agentGaveUp, browserTaskModel, taskStepLimit } from "./agent";

type Captured = { path: string; headers: Record<string, string>; body: Record<string, unknown> };
const captured: Captured[] = [];
const provider = Bun.serve({
	port: 0,
	fetch: async (request) => {
		captured.push({ path: new URL(request.url).pathname, headers: Object.fromEntries(request.headers), body: await request.json() as Record<string, unknown> });
		if (request.url.includes("/chat/completions")) {
			return Response.json({ choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
		}
		return Response.json({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
	},
});
afterAll(() => provider.stop(true));
const base = `http://127.0.0.1:${provider.port}`;
const ask = { system: "s", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }] };

describe("the browser task model", () => {
	test("defaults to the app's own OpenAI model, key and endpoint (an OpenAI-compatible gateway included)", async () => {
		const model = browserTaskModel({ OPENAI_API_KEY: "sk-app", OPENAI_API_BASE_URL: `${base}/v1`, OPENAI_MODEL: "gpt-test" });
		expect(model.id).toBe("openai/gpt-test");
		await model.complete(ask);
		expect(captured.at(-1)).toMatchObject({ path: "/v1/chat/completions", headers: { authorization: "Bearer sk-app" }, body: { model: "gpt-test" } });
		expect(browserTaskModel({ OPENAI_API_KEY: "sk-app" }).id).toBe("openai/gpt-5.5");
	});

	test("takes PHISHING_TASK_MODEL, whose OpenRouter-style id may itself contain a slash", async () => {
		const model = browserTaskModel({ PHISHING_TASK_MODEL: " openai/anthropic/claude-sonnet-4.5 ", OPENAI_API_KEY: "sk-app", OPENAI_API_BASE_URL: `${base}/api/v1` });
		await model.complete(ask);
		expect(captured.at(-1)).toMatchObject({ path: "/api/v1/chat/completions", body: { model: "anthropic/claude-sonnet-4.5" } });
	});

	test("uses Anthropic with its own key and endpoint", async () => {
		const model = browserTaskModel({ PHISHING_TASK_MODEL: "anthropic/claude-sonnet-4-5", ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: base, OPENAI_API_KEY: "sk-app" });
		expect(model.id).toBe("anthropic/claude-sonnet-4-5");
		await model.complete(ask);
		expect(captured.at(-1)).toMatchObject({ path: "/v1/messages", headers: { "x-api-key": "sk-ant" }, body: { model: "claude-sonnet-4-5" } });
		expect(captured.at(-1)?.headers.authorization).toBeUndefined();
	});

	test("refuses a configuration that cannot work, before any browser is leased", () => {
		expect(() => browserTaskModel({})).toThrow("OPENAI_API_KEY is required for the browser task model.");
		expect(() => browserTaskModel({ PHISHING_TASK_MODEL: "anthropic/claude-sonnet-4-5", OPENAI_API_KEY: "sk-app" })).toThrow("ANTHROPIC_API_KEY");
		for (const spec of ["gpt-5.5", "google/gemini", "openai/", "openai/has space"]) {
			expect(() => browserTaskModel({ PHISHING_TASK_MODEL: spec, OPENAI_API_KEY: "sk-app" })).toThrow("PHISHING_TASK_MODEL must be openai/<model> or anthropic/<model>.");
		}
	});
});

describe("step limits from the environment", () => {
	test("default when unset, the value when in range, and a configuration error otherwise", () => {
		expect(taskStepLimit("X_STEPS", undefined, 40, 100)).toBe(40);
		expect(taskStepLimit("X_STEPS", "  ", 40, 100)).toBe(40);
		expect(taskStepLimit("X_STEPS", " 12 ", 40, 100)).toBe(12);
		expect(taskStepLimit("X_STEPS", "100", 40, 100)).toBe(100);
		for (const value of ["0", "101", "-1", "1.5", "1e2", "twelve", "NaN"]) {
			expect(() => taskStepLimit("X_STEPS", value, 40, 100)).toThrow("X_STEPS must be a whole number from 1 to 100.");
		}
	});
});

describe("a run the agent itself gave up", () => {
	const step = (tool: string, ok = true) => ({ actions: [{ tool, ok }] });
	test("is a failed run whose last step is an accepted fail call; errors, aborts and limits are not", () => {
		expect(agentGaveUp({ status: "failed", steps: [step("click"), step("fail")] })).toBeTrue();
		expect(agentGaveUp({ status: "failed", steps: [step("fail", false)] })).toBeFalse();
		expect(agentGaveUp({ status: "failed", steps: [step("click")] })).toBeFalse();
		expect(agentGaveUp({ status: "failed", steps: [] })).toBeFalse();
		expect(agentGaveUp({ status: "step_limit", steps: [step("fail")] })).toBeFalse();
	});
});

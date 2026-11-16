import type OpenAI from "openai";

import { defaultResponseModel, getOpenAIClient } from "../../utils";
import { DECISION_TOOL_DEFINITIONS, runDecisionTool, type DecisionToolContext, type DecisionToolDependencies } from "./tools";

/** What the agent decided: an answer exactly as it wrote it, or why it sent none. */
export type DecisionAgentOutcome =
	| { kind: "answer"; text: string; attachments: string[]; summary: string }
	| { kind: "do_not_answer"; reason: string };

/** Every step of a run, kept with the case: what the model called, with what, and what it got back. */
export type DecisionAgentStep = { tool: string; arguments: unknown; result?: unknown };

/** One model turn; tests replace it with a scripted model. */
export type DecisionAgentModel = (request: { input: unknown[]; instructions: string }) => Promise<{ output: Array<Record<string, unknown>> }>;

const MAX_TURNS = 24;

const INSTRUCTIONS = [
	"You work for phishing.support, a service that reports phishing and malware sites to the providers who can take them down.",
	"A provider reviewed one of our reports and came back with a decision; the context has the decision, our report as filed, the case behind it, and the whole correspondence on it so far.",
	"Decide whether answering would get the abuse acted on, and if so, answer.",
	"Investigate first: use the tools to see what the reported URL serves right now, the way its victims and the provider's reviewer would get it. recheck_page shows one page; visit_site walks the site like a victim, with instructions you give its agent, when what matters only appears after clicks or forms. Sites cloak (they send datacenter, Tor and reviewer traffic to a decoy), gate on the visitor's platform, hide commands in dialogs, and serve payloads only to command-line downloaders. Look things up on the web when it helps, for example the provider's own abuse policy or a registrar's obligations.",
	"Answer only when it helps: the abuse is still there, or the provider misread the report, asked for something we can give, or sent it to the wrong place. Address what they actually said. Write as a knowledgeable person would, in plain language, with the concrete evidence they need to see it themselves. When it does not help (the provider is right, the content is gone, or there is nothing new to say), do not answer.",
	"Your text is sent exactly as you write it, to the channel the context names. Finish with exactly one call: answer or do_not_answer.",
].join("\n\n");

function defaultModel(client: OpenAI = getOpenAIClient()): DecisionAgentModel {
	return async ({ input, instructions }) => await client.responses.create({
		model: defaultResponseModel,
		instructions,
		input,
		tools: [{ type: "web_search" }, ...DECISION_TOOL_DEFINITIONS],
		reasoning: { effort: "high" },
		// Stateless: each turn carries the previous turns' encrypted reasoning.
		store: false,
		include: ["reasoning.encrypted_content"],
	} as never) as unknown as { output: Array<Record<string, unknown>> };
}

function parsedArguments(call: Record<string, unknown>): Record<string, unknown> {
	try {
		const value = JSON.parse(String(call.arguments ?? "{}"));
		return value && typeof value === "object" ? value as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

/**
 * Let the model investigate a provider's decision with its tools and decide
 * whether, and what, to answer. It runs until the model calls `answer` or
 * `do_not_answer`; a model that stops without either is reminded once per
 * turn, and a run that never decides fails, so the job retries it.
 */
export async function runDecisionAgent(params: {
	context: Record<string, unknown>;
	tools: DecisionToolContext;
	model?: DecisionAgentModel;
	dependencies?: DecisionToolDependencies;
}): Promise<{ outcome: DecisionAgentOutcome; steps: DecisionAgentStep[] }> {
	const model = params.model ?? defaultModel();
	const steps: DecisionAgentStep[] = [];
	const input: unknown[] = [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(params.context) }] }];
	for (let turn = 0; turn < MAX_TURNS; turn++) {
		params.dependencies?.signal?.throwIfAborted();
		const response = await model({ input, instructions: INSTRUCTIONS });
		input.push(...response.output);
		const calls = response.output.filter((item) => item.type === "function_call");
		for (const item of response.output.filter((entry) => entry.type === "web_search_call")) steps.push({ tool: "web_search", arguments: item.action ?? null });
		const final = calls.find((call) => call.name === "answer" || call.name === "do_not_answer");
		if (final) {
			const args = parsedArguments(final);
			steps.push({ tool: String(final.name), arguments: args });
			const outcome: DecisionAgentOutcome = final.name === "answer"
				? { kind: "answer", text: String(args.text ?? ""), attachments: Array.isArray(args.attachments) ? args.attachments.map(String) : [], summary: String(args.summary ?? "") }
				: { kind: "do_not_answer", reason: String(args.reason ?? "") };
			return { outcome, steps };
		}
		if (!calls.length) {
			input.push({ role: "user", content: [{ type: "input_text", text: "Finish by calling answer or do_not_answer." }] });
			continue;
		}
		for (const call of calls) {
			const args = parsedArguments(call);
			const result = await runDecisionTool(String(call.name), args, params.tools, params.dependencies);
			steps.push({ tool: String(call.name), arguments: args, result });
			input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
		}
	}
	throw new Error(`The follow-up agent did not decide within ${MAX_TURNS} turns.`);
}

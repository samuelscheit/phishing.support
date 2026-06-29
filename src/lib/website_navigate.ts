import fs, { writeFileSync } from "fs";
import path from "path";
import { config } from "dotenv";
import { defaultReasoning, defaultResponseModel, model, sleep } from "./utils";
import type { ResponseCreateParamsNonStreaming, ResponseInput } from "openai/resources/responses/responses.mjs";
import type { ElementHandle, Page } from "rebrowser-puppeteer-core";
import { getBrowserPage } from "./browser";

config({
	path: path.join(__dirname, "..", "..", ".env"),
	quiet: true,
});

const selector = "input, textarea, select, button, a, fieldset, label, div[role='button'], div[role='link']";

function elementQuery(action: "list" | "find", selector: string, targetLabel?: string) {
	function normalize(value: string) {
		return value.replace(/\s+/g, " ").trim();
	}

	function isVisible(el: Element) {
		const element = el as HTMLElement;
		if (!element.isConnected) return false;

		const style = globalThis.getComputedStyle(element);
		if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || element.hasAttribute("hidden")) {
			return false;
		}

		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	}

	function getLabelText(el: Element) {
		const candidates = [el.textContent, el.getAttribute("placeholder")];

		for (const candidate of candidates) {
			const text = candidate ? normalize(candidate) : "";
			if (text) return text;
		}

		return null;
	}

	function parseTargetLabel(value?: string) {
		const normalized = normalize(value || "");
		if (!normalized) return { base: "", index: 1 };

		const match = normalized.match(/^(.*)\s\[(\d+)\]$/);
		if (!match) return { base: normalized, index: 1 };

		return {
			base: normalize(match[1]!),
			index: Number.parseInt(match[2]!, 10) || 1,
		};
	}

	const elements = Array.from(globalThis.document.querySelectorAll(selector)).filter(isVisible);

	if (action === "list") {
		const counts = new Map<string, number>();
		const results: { label: string; description: string }[] = [];

		for (const el of elements) {
			const base = getLabelText(el);
			if (!base) continue;

			const key = base.toLowerCase();
			const count = (counts.get(key) || 0) + 1;
			counts.set(key, count);

			const label = count > 1 ? `${base} [${count}]` : base;
			const clone = el.cloneNode(true) as HTMLElement;
			clone.childNodes.forEach((child) => {
				clone.removeChild(child);
			});
			clone.textContent = el.textContent;

			const description = normalize(clone.outerHTML);

			results.push({ label, description });
		}

		return results;
	}

	const { base, index } = parseTargetLabel(targetLabel);
	if (!base) return null;

	let seen = 0;
	for (const el of elements) {
		const label = getLabelText(el);
		if (!label || label.toLowerCase() !== base.toLowerCase()) continue;

		seen += 1;
		if (seen === index) return el;
	}

	return null;
}

function find_element_by_label(page: Page, label: string) {
	label = label.trim().toLowerCase();

	console.log(`Searching for element with label: "${label}"`);

	return page.evaluateHandle(elementQuery, "find" as const, selector, label);
}

async function navigate_website() {
	const link = "https://saewar.com/De56Mgw1A";

	const { page, context } = await getBrowserPage();
	const dirname = path.join(__dirname, "..", "..", "data", "website_assets", new URL(link).hostname);

	const width = 1920;
	const height = 1080;

	await page.setViewport({ width, height });

	await page.goto(link, {
		waitUntil: "networkidle0",
	});

	let step = 0;

	let doContinue = true;

	const previous_summary: string[] = [];

	while (doContinue) {
		const screenshot = await page.screenshot({
			fullPage: false,
			captureBeyondViewport: false,
			type: "jpeg",
			quality: 80,
			encoding: "base64",
		});

		fs.writeFileSync(path.join(dirname, `website_${step}.jpg`), Buffer.from(screenshot, "base64"));

		const current_url = page.url();

		console.log("Calling ChatGPT with website data...", step);

		const input_elements = await page.evaluate(elementQuery, "list" as const, selector);
		const focused_element = await page.evaluate((selector) => {
			function normalize(value: string) {
				return value.replace(/\s+/g, " ").trim();
			}

			const el = globalThis.document.activeElement;
			if (!el || !(el instanceof HTMLElement)) return null;
			if (!el.matches(selector)) return null;

			const label = normalize(el.textContent || "") || normalize(el.getAttribute("placeholder") || "");
			if (!label) return null;

			const clone = el.cloneNode(true) as HTMLElement;
			clone.childNodes.forEach((child) => {
				clone.removeChild(child);
			});
			clone.textContent = el.textContent;

			const description = normalize(clone.outerHTML);

			return { label, description };
		}, selector);

		const explanation = {
			type: "string",
			description: "A brief explanation of the context and content of the website",
		};

		const previous_analysis_summary = previous_summary.length
			? `Previous analysis summary:
<summary>
${previous_summary.map((s, i) => `Step ${i + 1}: ${s}`).join("\n")}
</summary>`
			: undefined;

		const options: ResponseCreateParamsNonStreaming = {
			model: defaultResponseModel,
			tools: [
				{
					type: "web_search",
				},
				{
					type: "function",
					name: "click_element",
					description:
						'Clicks a visible element on the webpage by label. If a label appears multiple times, use the numbered form like "Label [2]" from the list.',
					parameters: {
						type: "object",
						properties: {
							label: {
								type: "string",
								description: "The label of the element to click (use the indexed form if duplicated)",
							},
							explanation,
						},
						required: ["label", "explanation"],
						additionalProperties: false,
					},
					strict: true,
				},
				{
					type: "function",
					name: "input_text",
					description: "Types text into the currently focused field. Focus a field by clicking it first.",
					parameters: {
						type: "object",
						properties: {
							text: {
								type: "string",
								description: "The text to input into the field",
							},
							explanation,
						},
						required: ["text", "explanation"],
						additionalProperties: false,
					},
					strict: true,
				},
				{
					type: "function",
					name: "end_analysis",
					description: "Ends the chat and analysis of the website",
					parameters: {
						type: "object",
						properties: {
							report: {
								type: "string",
								description:
									"A detailed report explaining the findings of the analysis, the steps taken and at the end a final conclusion on whether the website is a phishing website or not.",
							},
							is_phishing: {
								type: "boolean",
								description: "Whether the website is a phishing website or not",
							},
						},
						required: ["report", "is_phishing"],
						additionalProperties: false,
					},
					strict: true,
				},
			],
			input: [
				{
					role: "system",
					content: `You are an website analyzer that helps identify phishing websites. Your goal is to gather proof that the website is a phishing website by interacting with the website like a victim would. If prompted for any information, you should provide fake but realistic information and proceed. After each action, describe what you see on the page and suggest the next action to take. Only take the intended main route of the website (Do not change/enter any unecessary already prefilled forms) and when stop conditions are met, end the analysis by calling the end_analysis tool with a detailed report.

Interaction rules:
- Element labels come from visible text or placeholder attributes. If duplicates exist, use the numbered label like "Label [2]".
- To enter text, first click the field to focus it, then call input_text with only the text you want to type.

STOP CONDITIONS (must be enforced before ANY tool call):
- If the current page state appears to still request the same thing as the last step (e.g., still asks for the same input), you MUST call end_analysis rather than trying again.
- If you reach a point where no further progress can be made (e.g., no buttons to click, no fields to fill), you MUST call end_analysis.
- If you have collected enough information to make a determination, you MUST call end_analysis.
   `,
				},
				{
					role: "user",
					content: [
						...(previous_analysis_summary
							? ([
									{
										type: "input_text",
										text: previous_analysis_summary,
									},
								] as const)
							: []),
						{
							type: "input_text",
							text: `You started from ${link} and are now viewing the website at ${current_url}. You are at step ${step + 1}. Analyze the website and determine if it is a phishing website. Describe what you see and suggest the next action to take. You can use the provided functions to interact with the webpage.`,
						},
						{
							type: "input_text",
							text: `currently focused field (use input_text to enter text here if needed):
<focused>
${focused_element ? `LABEL: "${focused_element.label}" (${focused_element.description})` : "NONE"}
</focused>
`,
						},
						{
							type: "input_text",
							text: `visible elements on the page (labels use visible text or placeholder text; duplicates are numbered like "Label [2]"):
<elements>
${(input_elements as any[]).map((el) => `LABEL: "${el.label}" (${el.description})`).join("\n")}
</elements>
`,
						},
						{
							type: "input_image",
							image_url: `data:image/jpeg;base64,${screenshot}`,
							detail: "high", // text needs to be visible
						},
					],
				},
			],
			parallel_tool_calls: false,
			tool_choice: "required",
			reasoning: defaultReasoning,
			truncation: "auto",
			service_tier: "flex",
		};

		// console.dir(options, { depth: null });

		// @ts-ignore
		console.log(options.input[1].content.slice(0, -1));

		var response: any = await model.responses.create(options);

		console.log(response.output, step);

		writeFileSync(path.join(dirname, `analysis_step_${step}.json`), JSON.stringify(response, null, "\t"));

		for (const output of response.output) {
			try {
				if (output.type === "function_call") {
					if (output.name === "click_element") {
						const args = JSON.parse(output.arguments);
						const { label, explanation } = args as { label: string; explanation: string };

						const element = (await find_element_by_label(page, label)) as ElementHandle<Element> | null;

						if (!element) {
							throw new Error(`Element with label "${label}" not found`);
						} else {
							previous_summary.push(`Clicked element with label "${label}": ${explanation}`);

							await element.click();

							await page.waitForNetworkIdle({});
							await sleep(2000);
						}
					} else if (output.name === "input_text") {
						const args = JSON.parse(output.arguments);
						const { text, explanation } = args as { text: string; explanation: string };

						previous_summary.push(`Input text "${text}": ${explanation}`);

						await page.keyboard.type(text, { delay: 100 });
					} else if (output.name === "end_analysis") {
						const args = JSON.parse(output.arguments);
						const { report, is_phishing } = args as { report: string; is_phishing: boolean };

						console.log("Analysis ended by model.", report, is_phishing);
						doContinue = false;
						break;
					} else {
						console.log("Unknown function call:", output);
					}
				} else if (output.type === "reasoning") {
					console.log("Reasoning:", output);
					// previous_summary.push(...output.summary);
				} else {
					console.log("Unknown output type:", output);
				}
			} catch (error) {
				console.error("Error processing output:", output, error);
				previous_summary.push(`Error processing output at step ${step}: ${error}`);
			}
		}

		step += 1;

		if (step >= 8) {
			console.log("Reached maximum number of steps, ending analysis.");
			doContinue = false;
			// TODO: generate final report

			await model.responses.create({
				...options,
				input: [
					...(options.input as ResponseInput),
					{
						role: "system",
						content: `You have reached the maximum number of steps allowed for the analysis. Please generate a final report based on the actions taken so far and conclude whether the website is a phishing website or not.`,
					},
				],
				tools: options.tools!.filter((tool) => tool.type === "function" && tool.name === "end_analysis"),
			});
		}
	}
}

navigate_website();

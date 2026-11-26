import { CANARY_FIELD_LABEL, type WebsiteAccessStep } from "../types";

/**
 * The steps a provider's reviewer repeats to see what the visit saw, as
 * plain text: every report channel renders them with this module, so a
 * reviewer reads the same steps wherever the report reaches them.
 */

const HEADING = "How to reach the content";
const MAX_VALUE = 200;
const MAX_FIELD = 80;
/** What the visit did in a page, rather than only moving between pages. */
const IN_PAGE = new Set<WebsiteAccessStep["action"]>(["type", "select", "click", "press", "drag", "upload"]);

const cut = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
const quoted = (text: string, length: number) => JSON.stringify(cut(text, length));

/** Whether the steps are worth telling: the visit did something in a page, not only open it. */
export function hasAccessSteps(steps: readonly WebsiteAccessStep[] | undefined): steps is readonly WebsiteAccessStep[] {
	return Boolean(steps?.some((step) => IN_PAGE.has(step.action)));
}

function heading(steps: readonly WebsiteAccessStep[]): string {
	return steps.some((step) => step.actor === "human")
		? `${HEADING} (values were made up by us, or typed by a person who took over our browser):`
		: `${HEADING} (every value was made up by us and belongs to no one):`;
}

function stepText(step: WebsiteAccessStep): string {
	const field = step.field ? quoted(step.field, MAX_FIELD) : undefined;
	const value = step.value ? quoted(step.value, MAX_VALUE) : "";
	const made = step.synthetic ? ` (our made-up ${Object.hasOwn(CANARY_FIELD_LABEL, step.synthetic) ? CANARY_FIELD_LABEL[step.synthetic as keyof typeof CANARY_FIELD_LABEL] : step.synthetic})` : "";
	const text = (() => {
		switch (step.action) {
			case "type": return `${field ? `In ${field} enter` : "Enter"} ${value}${made}`;
			case "select": return `${field ? `In ${field} choose` : "Choose"} ${value}`;
			case "click": return field ? `Click ${field}` : "Click in the page";
			case "press": return `Press ${step.value ?? "a key"}`;
			case "drag": return field ? `Drag ${field}` : "Drag in the page";
			case "upload": return field ? `Upload a file to ${field}` : "Upload a file";
			case "open": return `Open ${step.value ?? step.pageUrl}`;
			case "back": return "Go back";
			case "forward": return "Go forward";
			case "reload": return "Reload the page";
			case "tab": return `Switch to the tab showing ${step.value ?? "the new page"}`;
		}
	})();
	return `${text}${step.actor === "human" ? " [by a person]" : ""}`;
}

/**
 * Each step's line, with a line naming the page whenever the step is done on
 * another page than the step before it in `shown`. A URL always ends its
 * line: a reader (and a link check) never takes punctuation for part of it.
 */
function lines(steps: readonly WebsiteAccessStep[], shown: readonly number[]): string[] {
	const result: string[] = [];
	let page = steps[0]!.action === "open" ? undefined : steps[0]!.pageUrl;
	if (page) result.push(`Open ${page}`);
	const omitted = (count: number) => `… ${count} more ${count === 1 ? "step" : "steps"} …`;
	let previous = -1;
	for (const index of shown) {
		const step = steps[index]!;
		if (index !== previous + 1) {
			result.push(omitted(index - previous - 1));
			page = undefined;
		}
		if (step.action !== "open" && step.pageUrl !== page) result.push(`Continue on ${step.pageUrl}`);
		result.push(stepText(step));
		page = step.action === "open" ? step.value ?? step.pageUrl : step.pageUrl;
		previous = index;
	}
	if (previous < steps.length - 1) result.push(omitted(steps.length - 1 - previous));
	return result;
}

/**
 * The numbered steps under their heading, within `maxLength`: when they do
 * not fit, steps from the middle give way to a line saying how many, and the
 * case page (`caseUrl`) lists them all. `inline` puts them on one line, for
 * fields that keep no line breaks. Empty when the visit did nothing in a page
 * or not even the heading and one step fit.
 */
export function accessStepsText(steps: readonly WebsiteAccessStep[] | undefined, options: { maxLength: number; caseUrl?: string; inline?: boolean }): string {
	if (!hasAccessSteps(steps)) return "";
	const separator = options.inline ? " " : "\n";
	const render = (shown: readonly number[]) => {
		const numbered = lines(steps, shown).reduce<{ lines: string[]; number: number }>((acc, line) => {
			if (line.startsWith("… ")) return { lines: [...acc.lines, line], number: acc.number };
			return { lines: [...acc.lines, `${acc.number}. ${line}`], number: acc.number + 1 };
		}, { lines: [], number: 1 }).lines;
		const omitted = shown.length < steps.length && options.caseUrl ? [`All steps: ${options.caseUrl}`] : [];
		return [heading(steps), ...numbered, ...omitted].join(separator);
	};
	for (let kept = steps.length; kept >= 1; kept -= 1) {
		const head = Math.ceil(kept / 2);
		const shown = [...steps.keys()].filter((index) => index < head || index >= steps.length - (kept - head));
		const text = render(shown);
		if (text.length <= options.maxLength) return text;
	}
	return "";
}

/**
 * One sentence for a field too small for the steps: that the content shows
 * only after them, and where they are listed.
 */
export function accessStepsNotice(steps: readonly WebsiteAccessStep[] | undefined, caseUrl: string | undefined): string {
	if (!hasAccessSteps(steps)) return "";
	const how = steps.some((step) => step.action === "type" || step.action === "select") ? "entering values in the site's forms" : "clicking through the site";
	return `The content shows only after ${how}${caseUrl ? `; the steps to reach it are listed at ${caseUrl}` : ""}.`;
}

/** Every address the steps name, for the checks that hold a text to its approved links. */
export function accessStepUrls(steps: readonly WebsiteAccessStep[] | undefined): string[] {
	return [...new Set((steps ?? []).flatMap((step) => [step.pageUrl, ...(step.value?.match(/https?:\/\/[^\s<>'"`]+/gi) ?? [])]))];
}

/**
 * The text without its access-steps block: a text that quotes the steps
 * from another (a mail body from the report's description) is not a copy
 * of it, and the steps are rendered on their own wherever they appear.
 */
export function withoutAccessSteps(text: string): string {
	const kept: string[] = [];
	let inBlock = false;
	for (const line of text.split("\n")) {
		if (line.startsWith(HEADING)) {
			inBlock = true;
			continue;
		}
		if (inBlock && /^(?:\d+\. |… \d+ more step|All steps: )/.test(line)) continue;
		inBlock = false;
		kept.push(line);
	}
	return kept.join("\n");
}

import type { WebsiteAccessAction, WebsiteAccessStep } from "../website/types";
import type { VisitAgentAction } from "./agent";

/** A page the visit showed, from when on (`VisitPage.shownFrom` with its archive's URL). */
export type ShownPage = { url: string; shownFrom: Date };

const SECRET_PLACEHOLDER = /^\{\{secret:(\w+)\}\}$/;
const MADE_UP = /^made-up (.+)$/;
const AGENT_REF = /^(?:f\d+)?e\d+$/;
const QUOTED_LABEL = /"((?:[^"\\]|\\.)*)"$/;

/** What each recorded kind does in the page; kinds without one (thoughts, scrolls, messages, takeovers, captures) are no access step. */
const ACTIONS: Record<VisitAgentAction["actor"], Partial<Record<string, WebsiteAccessAction>>> = {
	agent: { type: "type", select: "select", click: "click", press: "press", upload: "upload", navigate: "open", back: "back" },
	human: { type: "type", click: "click", key: "press", drag: "drag", back: "back", forward: "forward", reload: "reload", tab: "tab" },
};

/**
 * The element as a reader names it: the label it showed (the quoted part of
 * `textbox "Email"` or `input#email[name=email] "Email address"`), else its
 * name, id or role. An agent ref alone (`e12`) names nothing outside its
 * observation.
 */
export function accessField(selector: string | undefined): string | undefined {
	if (!selector || AGENT_REF.test(selector)) return undefined;
	const quoted = QUOTED_LABEL.exec(selector)?.[1];
	if (quoted) {
		try {
			return JSON.parse(`"${quoted}"`) as string;
		} catch {
			return quoted;
		}
	}
	return /\[name=([^\]]+)\]/.exec(selector)?.[1] ?? /#([\w-]+)/.exec(selector)?.[1] ?? selector;
}

/** The value an action used that its record keeps only in its text: the key pressed, the address opened, the tab switched to. */
function valueOf(action: VisitAgentAction, kind: WebsiteAccessAction): string | undefined {
	switch (kind) {
		// The agent's outcome goes on after a `; ` (`pressed Enter; the page navigated`).
		case "press": return /^pressed ([^;]+)/i.exec(action.text)?.[1]?.trim();
		case "open": return /^opened ([^\s;]+)/.exec(action.text)?.[1];
		case "tab": return /showing (\S+)$/.exec(action.text)?.[1];
		case "type": case "select": return action.value || undefined;
		default: return undefined;
	}
}

/** Which made-up value it was: the secret's name, or the made-up field a person inserted. */
function syntheticOf(action: VisitAgentAction): string | undefined {
	const typedAs = action.typedAs ?? "";
	return SECRET_PLACEHOLDER.exec(typedAs)?.[1] ?? MADE_UP.exec(typedAs)?.[1];
}

/**
 * What the visit did in its pages, in the order it did it, as a person
 * repeats it: the agent's and the person's actions that changed something
 * in the page or moved between pages. An agent action names the page it
 * acted on; a person's is matched to the page shown when they did it.
 * Refused agent actions and a field typed into and erased again are left out.
 */
export function visitAccessSteps(actions: readonly VisitAgentAction[], pages: readonly ShownPage[]): WebsiteAccessStep[] {
	const pageAt = (at: string | undefined) => {
		const time = at ? Date.parse(at) : Number.NaN;
		return (Number.isNaN(time) ? undefined : pages.findLast((page) => page.shownFrom.getTime() <= time))?.url ?? pages[0]?.url ?? "";
	};
	return actions.flatMap((action): WebsiteAccessStep[] => {
		const kind = ACTIONS[action.actor][action.kind];
		if (!kind || action.failed) return [];
		const value = valueOf(action, kind);
		if ((kind === "type" || kind === "select") && !value) return [];
		const field = accessField(action.selector);
		const synthetic = kind === "type" ? syntheticOf(action) : undefined;
		const step: WebsiteAccessStep = {
			actor: action.actor,
			pageUrl: action.page ?? pageAt(action.at),
			action: kind,
			...(field ? { field } : {}),
			...(value ? { value } : {}),
			...(synthetic ? { synthetic } : {}),
			at: action.at ?? "",
		};
		// The agent's `type … submit` pressed Enter after typing.
		return kind === "type" && action.actor === "agent" && /\bpressed Enter\b/.test(action.text)
			? [step, { actor: "agent", pageUrl: step.pageUrl, action: "press", value: "Enter", at: step.at }]
			: [step];
	});
}

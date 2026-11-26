"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MAX_REPORTER_INSTRUCTION_CHARS, type ReporterInstructions } from "@/lib/submissions/instructions";

/** The two instruction texts as typed, before the server trims them. */
export type ReporterInstructionsDraft = { browser: string; analysis: string };

export function instructionsDraft(instructions?: ReporterInstructions): ReporterInstructionsDraft {
	return { browser: instructions?.browser ?? "", analysis: instructions?.analysis ?? "" };
}

const FIELDS = [
	{
		key: "browser",
		label: "For the browser agent",
		placeholder: "Click 'Download PDF', then enter an email address.",
		help: "How the agent that visits the site should drive it: what to click, open or fill in.",
	},
	{
		key: "analysis",
		label: "For the analysis",
		placeholder: "The page impersonates my bank, Example Bank.",
		help: "What the analysis should look at or know. It is read as your claim, not as evidence.",
	},
] as const;

/** The reporter's optional instructions for the visit and the analysis, each at most 2,000 characters. */
export function ReporterInstructionsFields({ value, onChange, disabled }: { value: ReporterInstructionsDraft; onChange: (value: ReporterInstructionsDraft) => void; disabled?: boolean }) {
	const id = useId();
	return (
		<div className="space-y-3">
			{FIELDS.map((field) => (
				<div key={field.key} className="space-y-1.5">
					<div className="flex items-baseline justify-between gap-2">
						<Label htmlFor={`${id}-${field.key}`}>{field.label}</Label>
						<span className="text-xs tabular-nums text-muted-foreground">
							{value[field.key].length.toLocaleString("en-US")}/{MAX_REPORTER_INSTRUCTION_CHARS.toLocaleString("en-US")}
						</span>
					</div>
					<Textarea
						id={`${id}-${field.key}`}
						rows={3}
						maxLength={MAX_REPORTER_INSTRUCTION_CHARS}
						placeholder={field.placeholder}
						value={value[field.key]}
						disabled={disabled}
						onChange={(e) => onChange({ ...value, [field.key]: e.target.value })}
					/>
					<p className="text-xs text-muted-foreground">{field.help}</p>
				</div>
			))}
			<p className="text-xs text-muted-foreground">The text is shown to the agent and kept in the case record.</p>
		</div>
	);
}

/** The reporter's instructions, as submitted, shown as plain text. */
export function ReporterInstructionsView({ instructions }: { instructions: ReporterInstructions }) {
	return (
		<dl className="space-y-2 text-sm">
			{FIELDS.filter((field) => instructions[field.key]).map((field) => (
				<div key={field.key}>
					<dt className="text-xs text-muted-foreground">{field.label}</dt>
					<dd className="whitespace-pre-wrap break-words">{instructions[field.key]}</dd>
				</div>
			))}
		</dl>
	);
}

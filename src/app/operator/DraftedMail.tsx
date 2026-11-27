"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, Send, Trash2 } from "lucide-react";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { postJson } from "@/lib/http/client";

/** One operator action against an API route: busy while it runs, its refusal shown, the page refreshed after it. */
export function useOperatorAction() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const run = async (url: string, body: unknown) => {
		setBusy(true);
		setError(undefined);
		const result = await postJson(url, body);
		const failure = result.ok ? undefined : result.error;
		setBusy(false);
		if (failure) setError(failure);
		else router.refresh();
		return !failure;
	};
	return { busy, error, run };
}

export function ErrorLine({ error }: { error?: string }) {
	return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
}

/**
 * A drafted mail the operator edits, approves or discards: a criminal
 * referral, a preservation notice, or an escalation to an oversight body.
 * It is sent exactly as approved. `children` sits above the actions (the
 * referral's attachments).
 */
/** An action that cannot be undone, asked once more with what it does. */
function Confirmed({ trigger, title, description, action, destructive = false, onConfirm }: { trigger: ReactNode; title: string; description: ReactNode; action: string; destructive?: boolean; onConfirm: () => void }) {
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription asChild><div className="space-y-2 text-sm text-muted-foreground">{description}</div></AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction onClick={onConfirm} className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}>{action}</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/**
 * A drafted mail the operator edits, approves or discards: a criminal
 * referral, a preservation notice, or an escalation to an oversight body.
 * It is sent exactly as approved; edits not saved yet are sent with it.
 * `children` sits above the actions (the referral's attachments).
 */
export function DraftEditor({ mail, children }: { mail: { routeId: string; subject?: string; body?: string; recipient: string; recipientLabel: string }; children?: ReactNode }) {
	const { busy, error, run } = useOperatorAction();
	const [subject, setSubject] = useState(mail.subject ?? "");
	const [body, setBody] = useState(mail.body ?? "");
	const changed = subject !== mail.subject || body !== mail.body;
	const url = `/api/operator/drafted-mails/${mail.routeId}`;
	return (
		<div className="space-y-3">
			<label className="block space-y-1">
				<span className="text-xs font-medium text-muted-foreground">Subject</span>
				<Input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={400} aria-label={`Subject of the mail to ${mail.recipientLabel}`} />
			</label>
			<label className="block space-y-1">
				<span className="text-xs font-medium text-muted-foreground">Text</span>
				{/* Grows with the mail, so its last lines are seen before it is approved. */}
				<Textarea value={body} onChange={(event) => setBody(event.target.value)} className="max-h-[70vh] [field-sizing:content] font-mono text-xs leading-relaxed" aria-label={`Text of the mail to ${mail.recipientLabel}`} />
			</label>
			{children}
			<div className="flex flex-wrap items-center gap-2">
				<Confirmed
					trigger={<Button size="sm" disabled={busy}><Send />{changed ? "Approve with your edits and send" : "Approve and send"}</Button>}
					title="Send this mail?"
					description={<>
						<p>It goes to {mail.recipientLabel} ({mail.recipient}) exactly as written{changed ? ", with your edits" : ""}. A sent mail cannot be recalled.</p>
						<p className="font-medium text-foreground">{subject}</p>
					</>}
					action="Send"
					onConfirm={() => run(url, { action: "approve", subject, body })}
				/>
				<Button size="sm" variant="outline" disabled={busy || !changed} onClick={() => run(url, { action: "save", subject, body })}>
					<Check />{changed ? "Save draft" : "Saved"}
				</Button>
				<Confirmed
					trigger={<Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy}><Trash2 />Discard</Button>}
					title="Discard this mail?"
					description={<p>It is not sent to {mail.recipientLabel}, and the draft cannot be brought back.</p>}
					action="Discard"
					destructive
					onConfirm={() => run(url, { action: "discard" })}
				/>
			</div>
			<ErrorLine error={error} />
		</div>
	);
}

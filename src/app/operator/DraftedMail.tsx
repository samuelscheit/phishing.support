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
				<Input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={400} />
			</label>
			<label className="block space-y-1">
				<span className="text-xs font-medium text-muted-foreground">Text</span>
				<Textarea value={body} onChange={(event) => setBody(event.target.value)} rows={22} className="font-mono text-xs leading-relaxed" />
			</label>
			{children}
			<div className="flex flex-wrap items-center gap-2">
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button size="sm" disabled={busy}><Send />Approve and send</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Send this mail?</AlertDialogTitle>
							<AlertDialogDescription>
								It goes to {mail.recipientLabel} ({mail.recipient}) exactly as written. A sent mail cannot be recalled.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={() => run(url, { action: "approve", subject, body })}>Send</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
				<Button size="sm" variant="outline" disabled={busy || !changed} onClick={() => run(url, { action: "save", subject, body })}>
					<Check />Save draft
				</Button>
				<Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => run(url, { action: "discard" })}>
					<Trash2 />Discard
				</Button>
			</div>
			<ErrorLine error={error} />
		</div>
	);
}

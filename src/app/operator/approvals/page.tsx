import { Card, CardContent } from "@/components/ui/card";
import { listDraftedMails } from "@/lib/abuse/approval/drafted_mail";
import { openEscalationSteps, upcomingEscalationSteps } from "@/lib/abuse/escalation/manual";
import { ApprovalsClient } from "./ApprovalsClient";

export const dynamic = "force-dynamic";

/** Everything that waits on the operator: drafted mails nothing sends on its own, escalation steps only a person can take, and the escalation steps coming up. */
export default async function ApprovalsPage() {
	const now = new Date();
	const [mails, steps, upcoming] = await Promise.all([listDraftedMails(), openEscalationSteps(), upcomingEscalationSteps(now)]);
	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
				<p className="text-sm text-muted-foreground">Mails to authorities and oversight bodies wait here until you approve them, steps only you can take wait until you settle them, and the escalation steps coming up can be sent early or skipped.</p>
			</div>
			{mails.length === 0 && steps.length === 0 && upcoming.length === 0
				? <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">Nothing waits for you.</CardContent></Card>
				: <ApprovalsClient mails={mails} steps={steps} upcoming={upcoming} now={now.toISOString()} />}
		</div>
	);
}

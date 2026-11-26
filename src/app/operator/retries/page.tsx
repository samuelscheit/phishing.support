import Link from "next/link";
import { Globe, Mail } from "lucide-react";

import { SubmissionStatus } from "@/components/SubmissionStatus";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listRetryHistory, type RetryHistoryEntry } from "@/lib/submissions/retry_history";
import { formatUtcDateTime } from "@/lib/util/date_time";
import { WEBSITE_FINDING_LABELS } from "@/lib/website/types";

export const dynamic = "force-dynamic";

/** A case's status, finding and info line at one moment: before a retry or now. */
function CaseState({ state }: { state: RetryHistoryEntry["before"] }) {
	return (
		<div className="space-y-1">
			<SubmissionStatus status={state.status} />
			{state.finding ? <p className="text-xs font-medium">{WEBSITE_FINDING_LABELS[state.finding]}</p> : null}
			{state.info ? <p className="line-clamp-3 text-xs text-muted-foreground" title={state.info}>{state.info}</p> : null}
		</div>
	);
}

export default async function RetriedCasesPage() {
	const retries = await listRetryHistory();
	const cases = new Set(retries.map((retry) => retry.submissionId)).size;
	const automatic = retries.filter((retry) => retry.trigger === "automatic").length;
	return (
		<div className="space-y-6">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">Retried cases</h1>
				<p className="text-sm text-muted-foreground">Every time a failed or unreported case was analyzed again, newest first, with what it stood at before and what it stands at now.</p>
			</div>
			{retries.length === 0 ? (
				<Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No case was analyzed again yet.</CardContent></Card>
			) : (
				<Card>
					<CardContent className="space-y-4 pt-6">
						<div className="flex flex-wrap gap-2">
							<Badge variant="secondary">{retries.length} {retries.length === 1 ? "retry" : "retries"}</Badge>
							<Badge variant="outline">{cases} {cases === 1 ? "case" : "cases"}</Badge>
							<Badge variant="outline">{retries.length - automatic} manual</Badge>
							<Badge variant="outline">{automatic} automatic</Badge>
						</div>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-40">Retried</TableHead>
									<TableHead>Case</TableHead>
									<TableHead className="w-28">Trigger</TableHead>
									<TableHead className="w-56">Before</TableHead>
									<TableHead className="w-56">Now</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{retries.map((retry) => (
									<TableRow key={retry.id} className="align-top">
										<TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">{formatUtcDateTime(retry.retriedAt)}</TableCell>
										<TableCell className="max-w-0 align-top">
											<Link href={`/submissions/${retry.submissionId}`} className="flex items-center gap-1.5 font-medium text-primary hover:underline">
												{retry.kind === "website" ? <Globe className="h-3.5 w-3.5 shrink-0" /> : <Mail className="h-3.5 w-3.5 shrink-0" />}
												{retry.submissionId}
											</Link>
											<p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={retry.target}>{retry.target}</p>
											<p className="mt-1 text-xs text-muted-foreground">Analyzed again {retry.caseRetryCount === 1 ? "once" : `${retry.caseRetryCount} times`}</p>
										</TableCell>
										<TableCell className="align-top">
											<Badge variant={retry.trigger === "manual" ? "secondary" : "outline"} className="whitespace-nowrap capitalize">{retry.trigger}</Badge>
										</TableCell>
										<TableCell className="align-top"><CaseState state={retry.before} /></TableCell>
										<TableCell className="align-top"><CaseState state={retry.now} /></TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}
		</div>
	);
}

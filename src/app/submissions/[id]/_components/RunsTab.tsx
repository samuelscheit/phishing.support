import { AnalysisLogs } from "@/components/AnalysisLogs";
import type { SubmissionDetail } from "@/lib/submissions/details";
import { cn } from "@/lib/util/cn";
import { formatUtcDateTime } from "@/lib/util/date_time";
import { Clock } from "lucide-react";
import Link from "next/link";

function UnvisitedNote({ text }: { text: string }) {
	return <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{text}</div>;
}

/** A case waiting for its visit: where it stands, so the reader knows it is not stuck. */
export function QueuedVisit({ queue }: { queue: SubmissionDetail["visitQueue"] }) {
	const detail = queue?.kind === "queued"
		? queue.position === 1 ? "It is next in line for a browser." : `${queue.position - 1} ${queue.position === 2 ? "visit is" : "visits are"} ahead of it; every reporter's sites take turns.`
		: queue?.kind === "scheduled"
			? `It is due at ${formatUtcDateTime(queue.notBefore) ?? queue.notBefore}.`
			: undefined;
	return (
		<div className="flex items-start gap-3 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
			<Clock className="mt-0.5 h-4 w-4 shrink-0" />
			<p>
				The site is queued for its visit.{" "}
				{queue?.kind === "waiting" ? (
					<>It waits for the visit of <Link className="underline underline-offset-2" href={`/submissions/${queue.forSubmissionId}`}>a site of the same domain</Link> to finish first.</>
				) : detail}{" "}
				This page updates by itself.
			</p>
		</div>
	);
}

export function RunsTab({ submission, runs, isRunning }: { submission: SubmissionDetail; runs: SubmissionDetail["analysisRuns"]; isRunning: boolean }) {
	if (runs.length > 0) {
		return runs.map((run: any) => (
			<div key={run.id} className={isRunning ? "overflow-hidden" : "overflow-hidden flex flex-col h-[90vh]"}>
				<div className={cn(isRunning ? "p-0" : "p-0 flex-1 min-h-0", "pt-2")}>
					<AnalysisLogs
						streamId={run.id}
						progressStreamId={isRunning ? submission.id : undefined}
						status={run.status}
						output={run.output}
						className={isRunning ? undefined : "h-full"}
					/>
				</div>
			</div>
		));
	}
	if (isRunning) return <AnalysisLogs streamId={submission.id} status={submission.status} progressOnly />;
	if (submission.status === "queued") return <UnvisitedNote text="No analysis yet: the site waits for its visit." />;
	if (submission.status === "collected") return <UnvisitedNote text="No analysis: the site was not visited, because its domain is already reported." />;
	return <div className="text-center py-10 text-muted-foreground">No analysis runs yet.</div>;
}

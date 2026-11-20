import { AnalysisLogs } from "@/components/AnalysisLogs";
import type { SubmissionDetail } from "@/lib/submissions/details";
import { cn } from "@/web_lib/util";

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
	return <div className="text-center py-10 text-muted-foreground">No analysis runs yet.</div>;
}

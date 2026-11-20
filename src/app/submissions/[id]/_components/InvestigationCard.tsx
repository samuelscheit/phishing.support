import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatArtifactSize, type WebsiteData } from "./helpers";

type Investigation = NonNullable<WebsiteData["investigation"]>;

/** The pre-report investigation: payloads checked and the form probe, before any provider was contacted. */
export function InvestigationCard({ investigation }: { investigation: Investigation }) {
	return (
		<Card>
			<CardContent className="space-y-2 p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<div className="text-sm font-medium">Pre-report investigation</div>
						<div className="text-xs text-muted-foreground">
							{investigation.status === "completed"
								? `Evidence collected before any provider was contacted: ${investigation.payloads?.length ?? 0} command payload${investigation.payloads?.length === 1 ? "" : "s"}, ${investigation.backendCount ?? 0} data-drop backend${investigation.backendCount === 1 ? "" : "s"}.`
								: investigation.status === "failed"
									? "The investigation could not be completed; the report was sent with the evidence already captured."
									: "Payloads are downloaded and checked, and a controlled browser submits synthetic values, before the report is sent."}
						</div>
					</div>
					<Badge variant="outline" className="capitalize">{investigation.status}</Badge>
				</div>
				{investigation.payloads?.map((payload) => (
					<div key={payload.url} className="rounded border bg-muted/20 p-2 text-xs">
						<div className="font-mono">{payload.url}</div>
						{payload.sha256 ? <div className="text-muted-foreground">SHA-256 {payload.sha256}{payload.sizeBytes ? ` · ${formatArtifactSize(payload.sizeBytes)}` : ""}</div> : null}
						{payload.verdict ? <div className="font-medium text-destructive">{payload.verdict}</div> : null}
						{payload.error ? <div className="text-muted-foreground">Not downloaded: {payload.error}</div> : null}
					</div>
				))}
				{investigation.probeError ? <div className="text-xs text-muted-foreground">Form probe: {investigation.probeError}</div> : null}
			</CardContent>
		</Card>
	);
}

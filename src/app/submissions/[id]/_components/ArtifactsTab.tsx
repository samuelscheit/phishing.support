import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SubmissionDetail } from "@/lib/submissions/details";
import { formatUtcDateTime } from "@/lib/util/date_time";
import { formatArtifactSize, isWebsiteArchiveArtifact } from "./helpers";

export function ArtifactsTab({ artifacts }: { artifacts: SubmissionDetail["artifacts"] }) {
	if (artifacts.length === 0) {
		return <div className="text-center py-10 text-muted-foreground md:col-span-full">No artifacts found for this submission.</div>;
	}
	return artifacts.map((a) => (
		<Card key={a.id} className="overflow-hidden">
			{a.mimeType?.startsWith("image/") ? (
				<div className="aspect-video bg-muted relative">
					<img src={`/api/artifacts/${a.id}`} alt={a.name!} className="object-cover w-full h-full" />
				</div>
			) : (
				<div className="aspect-video flex items-center justify-center bg-muted">
					<ShieldAlert className="w-10 h-10 text-muted-foreground" />
				</div>
			)}
			<CardHeader className="p-3">
				<CardTitle className="text-xs truncate">{a.name || a.kind}</CardTitle>
				<CardDescription className="text-[10px]">
					{a.mimeType} • {formatArtifactSize(a.size)}
					{a.sha256 ? <div className="font-mono">SHA-256 {a.sha256}</div> : null}
					{isWebsiteArchiveArtifact(a) ? <div>Archived {formatUtcDateTime(a.archivedAt ?? a.createdAt) ?? "unknown date"}</div> : null}
				</CardDescription>
			</CardHeader>
			<CardContent className="p-3 pt-0">
				<a href={`/api/artifacts/${a.id}`} download={a.name} className="text-[10px] text-primary hover:underline font-medium">
					Download
				</a>
			</CardContent>
		</Card>
	));
}

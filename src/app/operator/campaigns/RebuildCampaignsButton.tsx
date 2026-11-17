"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Start a full regrouping of every confirmed site; it runs on the server in the background. */
export function RebuildCampaignsButton() {
	const [state, setState] = useState<"idle" | "busy" | "started" | "running" | "failed">("idle");
	const rebuild = async () => {
		setState("busy");
		const response = await fetch("/api/operator/campaigns/rebuild", { method: "POST" }).catch(() => undefined);
		const body = response?.ok ? await response.json().catch(() => undefined) as { state?: string } | undefined : undefined;
		setState(body?.state === "running" ? "running" : body?.state === "started" ? "started" : "failed");
	};
	return (
		<div className="flex items-center gap-3">
			{state === "started" && <span className="text-sm text-muted-foreground">Rebuild started; reload in a few minutes.</span>}
			{state === "running" && <span className="text-sm text-muted-foreground">A rebuild is already running.</span>}
			{state === "failed" && <span className="text-sm text-destructive">The rebuild could not be started.</span>}
			<Button variant="outline" size="sm" onClick={rebuild} disabled={state === "busy"}>
				<RefreshCw className={state === "busy" ? "animate-spin" : undefined} />
				Rebuild campaigns
			</Button>
		</div>
	);
}

"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/http/client";

/** Start a full regrouping of every confirmed site; it runs on the server in the background. */
export function RebuildCampaignsButton() {
	const [state, setState] = useState<"idle" | "busy" | "started" | "running" | "failed">("idle");
	const rebuild = async () => {
		setState("busy");
		const result = await postJson<{ state?: string }>("/api/operator/campaigns/rebuild");
		const state = result.ok ? result.data?.state : undefined;
		setState(state === "running" ? "running" : state === "started" ? "started" : "failed");
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

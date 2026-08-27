"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/web_lib/util";

type OutputItem = {
	type?: string;
	content?: Array<{ type?: string; text?: string; refusal?: string }>;
};

export function extractOutputText(output?: Array<OutputItem>): string | null {
	if (!output || !Array.isArray(output) || output.length === 0) return null;

	const parts: string[] = [];
	for (const item of output) {
		if (item?.type !== "message" || !Array.isArray(item.content)) continue;
		const chunk = item.content
			.map((c) => {
				if (c.type === "output_text") return c.text || "";
				if (c.type === "refusal") return c.refusal ? `Refusal: ${c.refusal}` : "Refusal";
				return "";
			})
			.join("");
		if (chunk.trim()) parts.push(chunk);
	}

	const text = parts.join("\n\n").trim();
	return text ? text : null;
}

export function AnalysisLogs({ streamId, output, className }: { streamId: string; output?: Array<OutputItem>; className?: string }) {
	const [logs, setLogs] = useState<string[]>([]);
	const streamingIndexRef = useRef<number | null>(null);
	const streamingTextRef = useRef("");
	const bottomRef = useRef<HTMLDivElement>(null);
	const outputText = useMemo(() => extractOutputText(output), [output]);
	const markdown = useMemo(() => {
		if (outputText) return outputText;
		return logs.join("\n\n");
	}, [logs, outputText]);

	const appendStreamingText = (delta: string) => {
		streamingTextRef.current += delta;
		setLogs((prev) => {
			if (streamingIndexRef.current === null || streamingIndexRef.current >= prev.length) {
				const next = [...prev, streamingTextRef.current];
				streamingIndexRef.current = next.length - 1;
				return next;
			}

			const next = [...prev];
			next[streamingIndexRef.current] = streamingTextRef.current;
			return next;
		});
	};

	const finalizeStreaming = () => {
		streamingIndexRef.current = null;
		streamingTextRef.current = "";
	};

	useEffect(() => {
		console.log("Starting log stream for", streamId);
		if (outputText) return;
		const res = new EventSource(`/api/stream/${streamId}`);

		res.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data.type === "response.output_text.delta" || data.type === "response.reasoning_summary_text.delta") {
					appendStreamingText(data.delta || "");
					return;
				}

				if (data.type === "analysis.step") {
					finalizeStreaming();
					const progress = typeof data.progress === "number" ? ` (${data.progress}%)` : "";
					setLogs((prev) => [...prev, `Step: ${data.step}${progress}`]);
					return;
				}

				if (data.type === "run.created") {
					finalizeStreaming();
					setLogs((prev) => [...prev, `Run created: #${data.runId}`]);
					return;
				}

				if (data.type === "run.started") {
					finalizeStreaming();
					setLogs((prev) => [...prev, "Run started"]);
					return;
				}

				if (data.type === "run.completed") {
					finalizeStreaming();
					setLogs((prev) => [...prev, "Run completed"]);
					return;
				}

				if (data.type === "run.failed") {
					finalizeStreaming();
					const err = data.error ? `: ${data.error}` : "";
					setLogs((prev) => [...prev, `Run failed${err}`]);
					return;
				}

				if (data.type === "run.retrying") {
					finalizeStreaming();
					const delay = typeof data.delayMs === "number" ? `; waiting ${Math.ceil(data.delayMs / 1000)}s` : "";
					setLogs((prev) => [...prev, `Transient provider error; retrying attempt ${data.attempt || "next"}${delay}`]);
					return;
				}

				if (data.type === "response.output_text.done") {
					finalizeStreaming();
					return;
				}

				if (data.type === "response.completed") {
					finalizeStreaming();
					setLogs((prev) => [...prev, "Response completed"]);
					return;
				}

				if (data.type === "connected") {
					setLogs((prev) => [...prev, "Stream connected"]);
					return;
				}

				finalizeStreaming();
				setLogs((prev) => [...prev, JSON.stringify(data)]);
			} catch (e) {
				// Handle non-JSON lines if any
				finalizeStreaming();
				setLogs((prev) => [...prev, event.data]);
			}
		};

		res.onerror = () => {
			res.close();
		};

		return () => res.close();
	}, [streamId, outputText]);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [markdown]);

	return (
		<ScrollArea className={cn("w-full", className ?? "h-96")}>
			<div className="space-y-3">
				{markdown ? (
					<MessageResponse isAnimating={!outputText}>{markdown}</MessageResponse>
				) : (
					<div className="text-sm text-muted-foreground">Waiting for output…</div>
				)}
				{!outputText ? <div className="animate-pulse inline-block w-2 h-4 bg-muted-foreground/60" /> : null}
				<div ref={bottomRef} />
			</div>
		</ScrollArea>
	);
}

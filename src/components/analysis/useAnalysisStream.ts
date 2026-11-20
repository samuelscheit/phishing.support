"use client";

import { useEffect, useReducer } from "react";
import { createInitialAnalysisStreamState } from "@/lib/analysis/stream_events";
import { reducer } from "./stream_state";

/** Subscribes to a run's event stream (and the submission's progress stream) and folds the events into the reader state. */
export function useAnalysisStream({ streamId, progressStreamId, progressOnly, outputText, status }: {
	streamId: string | bigint;
	progressStreamId?: string | bigint;
	progressOnly: boolean;
	outputText: string | null | undefined;
	status?: string;
}) {
	const [state, dispatch] = useReducer(reducer, status, createInitialAnalysisStreamState);
	const streamIdText = String(streamId);
	const progressStreamIdText = progressStreamId === undefined ? null : String(progressStreamId);

	useEffect(() => {
		const progressExpected = progressOnly || progressStreamIdText !== null;
		dispatch({ type: "reset", status, progressExpected });
		// A finished run has nothing new to stream. Avoid opening a never-ending
		// connection when a reader revisits a finished or failed analysis.
		if ((outputText || status === "completed" || status === "failed") && !progressExpected) return;
		const streamTargets = [
			...((outputText || status === "completed" || status === "failed") && progressStreamIdText
				? [{ id: progressStreamIdText, primary: false, progress: true }]
				: [{ id: streamIdText, primary: true, progress: progressOnly }]),
			...(progressStreamIdText &&
			progressStreamIdText !== streamIdText &&
			!(outputText || status === "completed" || status === "failed")
				? [{ id: progressStreamIdText, primary: false, progress: true }]
				: []),
		];
		const sources = streamTargets.map(({ id, primary, progress }) => ({
			source: new EventSource(`/api/stream/${encodeURIComponent(id)}${progress ? "?progress=1" : ""}`),
			primary,
			progress,
		}));
		let closed = false;
		let primaryFinishedNormally = false;
		let progressFinishedNormally = false;

		for (const { source, primary, progress } of sources) {
			source.onopen = () => {
				dispatch({ type: "open" });
			};
			source.onmessage = (event: MessageEvent<string>) => {
				if (closed) return;
				try {
					const parsed = JSON.parse(event.data);
					// The submission topic also receives every provider packet from
					// every analysis stage.  Use it only for the high-level progress
					// steps; otherwise the classifier's JSON response could replace
					// the narrative analysis while it is still being displayed.
					const eventType = parsed && typeof parsed === "object" ? (parsed as { type?: unknown }).type : undefined;
					if (primary && (eventType === "run.completed" || eventType === "run.failed")) primaryFinishedNormally = true;
					if (progress && eventType === "analysis.step" && parsed && typeof parsed === "object") {
						const step = (parsed as { step?: unknown }).step;
						const progressValue = (parsed as { progress?: unknown }).progress;
						if (step === "completed" || step === "failed" || progressValue === 100) progressFinishedNormally = true;
					}
					if (
						progressOnly &&
						primary &&
						eventType !== "analysis.step" &&
						eventType !== "run.failed" &&
						eventType !== "run.completed"
					)
						return;
					if (!primary && eventType !== "analysis.step") return;
					dispatch({ type: "event", event: parsed });
				} catch {
					// Keep malformed packets visible as a state change without rendering
					// untrusted/raw payloads into the page.
					if (primary) dispatch({ type: "event", event: { type: "stream.malformed" } });
				}
			};
			source.onerror = () => {
				const endedNormally = (primary && primaryFinishedNormally) || (progress && progressFinishedNormally);
				// Progress is a best-effort companion stream. A failure there should
				// not make an otherwise healthy analysis look broken when the primary
				// run stream is still available.
				if (!closed && !endedNormally && (primary || sources.length === 1)) {
					dispatch({ type: "error", message: primary ? undefined : "Progress updates paused." });
				}
				source.close();
			};
		}

		return () => {
			closed = true;
			for (const { source } of sources) source.close();
		};
	}, [outputText, progressOnly, progressStreamIdText, status, streamIdText]);

	return state;
}

"use client";

import { useEffect, useState } from "react";
import type { SubmissionDetail } from "@/lib/submissions/details";
import { postJson } from "@/lib/http/client";
import type { ReporterInstructionsDraft } from "@/components/ReporterInstructionsFields";

/** The submission, refreshed every three seconds, with the retry action. */
export function useSubmissionDetail(id: string, initial: SubmissionDetail | null | undefined) {
	const [submission, setSubmission] = useState<SubmissionDetail | null>(initial ?? null);
	const [loading, setLoading] = useState(!initial);
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | null>(null);

	useEffect(() => {
		const fetchDetail = async () => {
			try {
				const res = await fetch(`/api/submissions/${id}`);
				if (res.ok) setSubmission(await res.json());
			} catch (err) {
				console.error("Failed to fetch submission:", err);
			} finally {
				setLoading(false);
			}
		};
		fetchDetail();
		const interval = setInterval(fetchDetail, 3000);
		return () => clearInterval(interval);
	}, [id]);

	/** Analyze the case again; with `instructions` the reporter's stored ones are replaced, without them kept. */
	const retryAnalysis = async (instructions?: ReporterInstructionsDraft) => {
		setRetrying(true);
		setRetryError(null);
		try {
			const queued = await postJson(`/api/submissions/${id}/retry`, instructions ? { instructions } : undefined, "Retry failed");
			if (!queued.ok) throw new Error(queued.error);
			const refreshed = await fetch(`/api/submissions/${id}`);
			if (refreshed.ok) setSubmission(await refreshed.json());
		} catch (error) {
			setRetryError(error instanceof Error ? error.message : "Unable to queue retry.");
		} finally {
			setRetrying(false);
		}
	};

	return { submission, loading, retrying, retryError, retryAnalysis };
}

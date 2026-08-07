"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { SubmissionStatus } from "@/components/SubmissionStatus";
import { ReporterMeta } from "@/components/ReporterMeta";
import { Submission } from "../lib/db/schema";

export function SubmissionsList() {
	const [submissions, setSubmissions] = useState<Submission[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const fetchSubmissions = async () => {
			try {
				const res = await fetch("/api/submissions");
				if (res.ok) {
					const data = await res.json();
					setSubmissions(data);
				}
			} catch (err) {
				console.error("Failed to fetch submissions:", err);
			} finally {
				setLoading(false);
			}
		};

		fetchSubmissions();
		const interval = setInterval(fetchSubmissions, 5000);
		return () => clearInterval(interval);
	}, []);

	if (loading && submissions.length === 0) {
		return <div className="text-center py-10 text-muted-foreground">Loading submissions...</div>;
	}

	if (submissions.length === 0) {
		return <div className="text-center py-10 text-muted-foreground">No submissions found.</div>;
	}

	return (
		<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
			{submissions.map((s) => (
				<Link key={s.id} href={`/submissions/${s.id}`} className="block h-full min-w-0">
					<Card className="hover:bg-accent transition-colors cursor-pointer h-full w-full">
						<CardContent className="py-4 space-y-2 min-w-0">
							<div className="flex justify-between items-start gap-2">
								<SubmissionStatus status={s.status} />

								<span className="text-xs text-muted-foreground whitespace-nowrap">
									{formatDistanceToNow(new Date(s.createdAt), { addSuffix: true })}
								</span>
							</div>
							<CardTitle className="text-lg truncate min-w-0">
								{s.data?.kind === "email" ? s.data.email?.subject || s.dedupeKey : s.data.website.url}
							</CardTitle>
							<ReporterMeta reporterCountry={s.reporterCountry} reporterHeaders={s.reporterHeaders} />
						</CardContent>
					</Card>
				</Link>
			))}
		</div>
	);
}

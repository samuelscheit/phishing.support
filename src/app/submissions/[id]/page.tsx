import type { Metadata, ResolvingMetadata } from "next";
import { SubmissionsEntity } from "@/lib/db/entities";
import { getSubmissionDetails } from "@/lib/submissions/details";
import { notFound } from "next/navigation";
import { SubmissionPageClient } from "./SubmissionPageClient";
import { Submission } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

function safeHostname(rawUrl?: string): string | null {
	if (!rawUrl) return null;
	try {
		return new URL(rawUrl).hostname;
	} catch {
		return null;
	}
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }, _parent: ResolvingMetadata): Promise<Metadata> {
	const { id } = await params;

	let submission: Submission | undefined;
	try {
		submission = await SubmissionsEntity.get(BigInt(id));
	} catch {
		submission = undefined;
	}

	if (!submission) {
		return {
			title: "Submission Not Found — Phishing Support",
			robots: { index: false, follow: false },
		};
	}

	const targetName =
		submission.data.kind === "website"
			? safeHostname(submission.data.website?.url) || "Website Submission"
			: submission.data.email?.subject || "Email Submission";

	const title = `${targetName} — Submission #${submission.id.toString()} — Phishing Support`;

	return {
		title,
		description: "Submission detail view and analysis results.",
		robots: { index: false, follow: false },
	};
}

export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const initialSubmission = await getSubmissionDetails(id);
	if (!initialSubmission) notFound();

	return <SubmissionPageClient id={id} initialSubmission={initialSubmission} />;
}

import type { Metadata, ResolvingMetadata } from "next";
import { SubmissionsEntity } from "@/lib/db/entities/submissions";
import { getSubmissionDetails } from "@/lib/submissions/details";
import { notFound } from "next/navigation";
import { SubmissionPageClient } from "./SubmissionPageClient";
import { Submission } from "@/lib/db/schema";
import { submissionSeo } from "@/lib/seo/submission";
import { requestLocale } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

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
			title: "Submission not found",
			robots: { index: false, follow: false },
		};
	}

	const { title, description } = submissionSeo(submission);
	const path = `/submissions/${submission.id.toString()}`;
	return {
		title,
		description,
		alternates: { canonical: path },
		openGraph: { type: "article", url: path, title, description, publishedTime: submission.createdAt.toISOString() },
		// The page shows the phishing URLs it analyzed as text; it links to none of them.
		robots: { index: true, follow: true },
	};
}

export default async function SubmissionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const { id } = await params;
	const initialSubmission = await getSubmissionDetails(id);
	if (!initialSubmission) notFound();

	return <SubmissionPageClient id={id} initialSubmission={initialSubmission} locale={await requestLocale((await searchParams).lang)} />;
}

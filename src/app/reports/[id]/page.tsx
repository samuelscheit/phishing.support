import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { cache } from "react";

import { SubmissionReports } from "@/components/SubmissionReports";
import { PageShell } from "@/components/provider_stats/PageShell";
import { getReportsByIds } from "@/lib/submissions/abuse_details";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const reportFor = cache(async (id: string) => (/^\d{1,20}$/.test(id) ? (await getReportsByIds([BigInt(id)]))[0] : undefined));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
	const report = await reportFor((await params).id);
	if (!report) return { title: "Report not found", robots: { index: false, follow: false } };
	const targets = [...new Set(report.routes.map((route) => route.target))].join(", ");
	return { title: `Abuse report: ${targets}`, description: `The abuse report about ${targets}, every provider it went to, and the full correspondence.`, alternates: { canonical: `/reports/${report.id}` } };
}

/**
 * One report with every provider route and the whole correspondence. A
 * report made from a website or email submission lives on that case's page;
 * this page shows the others, such as reports made through the API.
 */
export default async function ReportPage({ params }: Props) {
	const { id } = await params;
	const report = await reportFor(id);
	if (!report) notFound();
	if (report.submissionId) permanentRedirect(`/submissions/${report.submissionId}`);
	return (
		<PageShell current={undefined}>
			<header className="space-y-3">
				<Link href="/reports" className="text-sm text-muted-foreground hover:text-foreground">← All reports</Link>
				<h1 className="break-words text-3xl font-bold tracking-tight">{[...new Set(report.routes.map((route) => route.target))].join(", ") || `Report ${report.id}`}</h1>
				<p className="max-w-3xl whitespace-pre-wrap text-pretty text-muted-foreground">{report.description}</p>
			</header>
			<SubmissionReports reports={[report]} />
		</PageShell>
	);
}

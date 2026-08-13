import type { Metadata } from "next";

import { AbuseStatusClient } from "@/components/AbuseStatusClient";
import { SiteFooter } from "@/components/SiteLayout";

export const metadata: Metadata = {
	title: "Report status | Phishing Support",
	description: "Private abuse-report status",
};

export default async function AbuseReportStatusPage({ params }: { params: Promise<{ trackingToken: string }> }) {
	const { trackingToken } = await params;
	return (
		<div className="min-h-screen">
			<header className="border-b bg-background/95">
				<div className="container mx-auto max-w-5xl px-4 py-8">
					<p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Phishing Support</p>
					<p className="mt-2 text-sm text-muted-foreground">This page is protected by your private tracking token.</p>
				</div>
			</header>
			<main className="container mx-auto max-w-5xl px-4 py-10"><AbuseStatusClient trackingToken={trackingToken} /></main>
			<SiteFooter />
		</div>
	);
}

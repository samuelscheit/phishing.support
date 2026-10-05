import type { Metadata } from "next";

import { AbuseReportForm } from "@/components/AbuseReportForm";
import { SiteFooter } from "@/components/SiteLayout";

export const metadata: Metadata = {
	title: "Abuse reporting | Phishing Support",
	description: "Unified abuse reporting for domain and server providers",
};

export default function AbuseReportingPage() {
	return (
		<div className="min-h-screen">
			<header className="border-b bg-background/95">
				<div className="container mx-auto max-w-5xl px-4 py-10">
					<p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Phishing Support</p>
					<h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
						Unified abuse reporting for domain and server providers
					</h1>
					<p className="mt-4 max-w-3xl text-lg text-muted-foreground">
						Submit public domains or IP addresses, explain the abuse, and add evidence. The service resolves verified provider
						routes and submits reports automatically after safety checks.
					</p>
				</div>
			</header>
			<main className="container mx-auto max-w-5xl px-4 py-10">
				<div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem]">
					<AbuseReportForm />
					<aside className="h-fit rounded-2xl border bg-muted/30 p-5 text-sm text-muted-foreground">
						<h2 className="font-semibold text-foreground">What to expect</h2>
						<ul className="mt-3 list-disc space-y-2 pl-5">
							<li>Targets are normalized and deduplicated while original inputs are retained.</li>
							<li>Only verified abuse contacts and code-owned provider forms are used.</li>
							<li>Evidence and correspondence are retained for auditability.</li>
							<li>A private token link is returned for status polling.</li>
						</ul>
					</aside>
				</div>
			</main>
			<SiteFooter />
		</div>
	);
}

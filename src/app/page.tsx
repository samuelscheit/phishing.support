import { SubmissionForm } from "@/components/SubmissionForm";
import { SubmissionsList } from "@/components/SubmissionsList";
import SiteLayout, { SiteFooter, SiteHeader } from "@/components/SiteLayout";
import type { Metadata } from "next";
import About from "../components/About";
import Link from "next/link";

export const metadata: Metadata = {
	title: "Phishing Support",
	description: "Automated analysis and reporting of phishing threats.",
};

export default function Home() {
	return (
		<div className="">
			<main className="container mx-auto px-4 space-y-10 min-h-[85vh] mb-10">
				<SiteHeader />
				<SubmissionForm />

				<div className="rounded-2xl border bg-muted/30 p-6">
					<h2 className="text-xl font-semibold">Need to report an abusive domain or server?</h2>
					<p className="mt-2 text-muted-foreground">Use the standalone public service for unified abuse reporting across domains and provider networks.</p>
					<Link href="/abuse-reporting" className="mt-4 inline-flex rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:opacity-90">Open abuse reporting</Link>
				</div>

				<div className="space-y-4">
					<h2 className="text-2xl font-semibold">Recent Submissions</h2>
					<SubmissionsList />
				</div>
			</main>

			<div className="container mx-auto px-4 max-w-2xl">
				<About />
			</div>

			<SiteFooter />
		</div>
	);
}

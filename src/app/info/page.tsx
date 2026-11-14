import type { Metadata } from "next";
import SiteLayout from "@/components/SiteLayout";
import About from "@/components/About";
import Donate from "@/components/Donate";
import Link from "next/link";

export const metadata: Metadata = {
	title: "About and contact",
	description: "Who runs Phishing Support, why it exists, how it reports phishing to registrars and hosting providers, and how to get in touch.",
	alternates: { canonical: "/info" },
};

export default function InfoPage() {
	return (
		<SiteLayout>
			<div className="space-y-10 container max-w-2xl mx-auto">
				<About />

				<div className="pt-4">
					<Link href="/" className="underline hover:text-primary">
						Back to Home
					</Link>
				</div>
			</div>
		</SiteLayout>
	);
}

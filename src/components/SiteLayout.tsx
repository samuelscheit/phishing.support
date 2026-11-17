import React from "react";
import Link from "next/link";
import { GUIDES } from "@/lib/seo/guides";

export function SiteHeader() {
	return (
		<header className="container mx-auto py-10 px-4">
			<div className="text-center space-y-2">
				<h1 className="text-4xl font-bold tracking-tight">Phishing Support</h1>
				<p className="text-muted-foreground text-lg">Automated analysis and reporting of phishing threats.</p>
			</div>
		</header>
	);
}

export function SiteFooter() {
	return (
		<footer className="border-t bg-background/50 mt-12">
			<div className="container mx-auto flex flex-col gap-4 px-4 py-6 sm:flex-row sm:items-start sm:justify-between">
				<p className="text-sm text-muted-foreground">© {new Date().getFullYear()} Phishing Support</p>
				<nav aria-label="Guides and information">
					<ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
						{GUIDES.map(({ slug, label }) => (
							<li key={slug}>
								<Link href={`/${slug}`} className="text-muted-foreground hover:text-primary hover:underline">
									{label}
								</Link>
							</li>
						))}
						<li>
							<Link href="/abuse-reporting" className="text-muted-foreground hover:text-primary hover:underline">
								Abuse reporting
							</Link>
						</li>
						<li>
							<Link href="/info" className="text-muted-foreground hover:text-primary hover:underline">
								About
							</Link>
						</li>
						<li>
							<Link href="/impressum" className="text-muted-foreground hover:text-primary hover:underline">
								Impressum
							</Link>
						</li>
						<li>
							<Link href="/datenschutz" className="text-muted-foreground hover:text-primary hover:underline">
								Datenschutz
							</Link>
						</li>
					</ul>
				</nav>
			</div>
		</footer>
	);
}

export function SiteLayout({ children }: { children: React.ReactNode }) {
	return (
		<>
			<SiteHeader />

			<main className="container mx-auto px-4">{children}</main>

			<SiteFooter />
		</>
	);
}

export default SiteLayout;

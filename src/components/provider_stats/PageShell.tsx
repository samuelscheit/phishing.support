import Link from "next/link";

import { SiteFooter } from "@/components/SiteLayout";
import { cn } from "@/lib/util/cn";

const SECTIONS = [
	{ href: "/providers", label: "Providers" },
	{ href: "/reports", label: "All reports" },
] as const;

/** The frame of the public statistics pages: home link, section switch, and the site footer. */
export function PageShell({ current, children }: { current: (typeof SECTIONS)[number]["href"] | undefined; children: React.ReactNode }) {
	return (
		<>
			<main className="container mx-auto max-w-6xl space-y-10 px-4 py-10">
				<nav className="flex flex-wrap items-center justify-between gap-4 text-sm" aria-label="Statistics">
					<Link href="/" className="text-muted-foreground hover:text-foreground">← Phishing Support</Link>
					<div className="inline-flex rounded-lg border p-0.5">
						{SECTIONS.map((section) => (
							<Link key={section.href} href={section.href} aria-current={current === section.href ? "page" : undefined} className={cn("rounded-md px-3 py-1.5", current === section.href ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}>
								{section.label}
							</Link>
						))}
					</div>
				</nav>
				{children}
			</main>
			<SiteFooter />
		</>
	);
}

/** One headline number with what it counts. */
export function Figure({ value, label, hint }: { value: React.ReactNode; label: string; hint?: string }) {
	return (
		<div className="space-y-0.5">
			<div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
			<div className="text-sm text-muted-foreground" title={hint}>{label}</div>
		</div>
	);
}

/** Previous/next links that keep the page's other search parameters. */
export function Pagination({ page, pageCount, href }: { page: number; pageCount: number; href: (page: number) => string }) {
	if (pageCount <= 1) return null;
	return (
		<nav className="flex items-center justify-between gap-4 text-sm" aria-label="Pages">
			{page > 1 ? <Link href={href(page - 1)} className="rounded-md border px-3 py-1.5 hover:bg-muted">← Newer</Link> : <span />}
			<span className="text-muted-foreground tabular-nums">Page {page} of {pageCount}</span>
			{page < pageCount ? <Link href={href(page + 1)} className="rounded-md border px-3 py-1.5 hover:bg-muted">Older →</Link> : <span />}
		</nav>
	);
}

import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { isOperatorAuthorization } from "@/lib/http/operator_auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
	title: "Operator",
	robots: { index: false, follow: false },
};

/** Every operator page checks the login itself; the proxy only asks for it first. */
export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
	if (!isOperatorAuthorization((await headers()).get("authorization"))) notFound();
	return (
		<div className="min-h-screen bg-muted/30">
			<header className="border-b bg-background">
				<nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 text-sm">
					<Link href="/" className="font-semibold">Phishing Support</Link>
					<Link href="/operator/campaigns" className="text-muted-foreground hover:text-foreground">Campaigns</Link>
					<Link href="/operator/retries" className="text-muted-foreground hover:text-foreground">Retried cases</Link>
				</nav>
			</header>
			<main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
		</div>
	);
}

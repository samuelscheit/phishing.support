import Link from "next/link";
import type { SubmissionDetail } from "@/lib/submissions/details";

type EmailData = NonNullable<Extract<SubmissionDetail["data"], { kind: "email" }>["email"]>;

/** The reported email's sender, subject and the websites linked from it. */
export function EmailFacts({ email }: { email: EmailData | undefined }) {
	return (
		<div className="space-y-2">
			<h4 className="text-sm font-semibold">Email</h4>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="rounded-lg border bg-muted/30 p-3">
					<div className="text-xs text-muted-foreground">From</div>
					<div className="mt-1 font-mono text-xs">{email?.from || "—"}</div>
				</div>
				<div className="rounded-lg border bg-muted/30 p-3">
					<div className="text-xs text-muted-foreground">Subject</div>
					<div className="mt-1 text-sm font-medium">{email?.subject || "—"}</div>
				</div>
			</div>
			{email?.linkedWebsites?.length ? (
				<div className="rounded-lg border bg-muted/30 p-3">
					<div className="text-xs text-muted-foreground">Linked websites, each analyzed in its own case</div>
					<ul className="mt-1 space-y-1">
						{email.linkedWebsites.map((link) => (
							<li key={link.url} className="flex items-start justify-between gap-3">
								<span className="min-w-0 font-mono text-xs">{link.url}</span>
								<Link href={`/submissions/${link.submissionId}`} className="shrink-0 text-xs font-medium text-primary hover:underline">
									Open case
								</Link>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}

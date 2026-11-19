"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Copy, Download, Fingerprint, LayoutGrid, LayoutTemplate, Rows3, Send, Timer, Wallet } from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { LANGUAGE_NAMES } from "@/lib/campaign/language";
import type { PublicCampaign, PublicCampaignReason, PublicCampaignSite, PublicReportState } from "@/lib/campaign/public_view";
import { formatUtcDateTime } from "@/lib/date_time";
import { cn } from "@/web_lib/util";

const PREVIEW_SITES = 3;

const REASON_ICON: Record<PublicCampaignReason["kind"], typeof Send> = {
	same_code: Fingerprint,
	same_page: Fingerprint,
	same_structure: LayoutTemplate,
	same_backend: Send,
	same_payment_account: Wallet,
	same_pattern: Timer,
};

const REPORT_STATE: Record<PublicReportState, { label: string; tone: "ok" | "wait" | "bad" | "muted" }> = {
	confirmed: { label: "confirmed by the provider", tone: "ok" },
	accepted: { label: "accepted", tone: "wait" },
	awaiting: { label: "sent, no answer yet", tone: "wait" },
	rejected: { label: "rejected", tone: "bad" },
	bounced: { label: "bounced", tone: "bad" },
	failed: { label: "failed", tone: "bad" },
	pending: { label: "pending", tone: "muted" },
};

const TAKEDOWN: Record<PublicCampaignSite["takedown"], { label: string; tone: "ok" | "wait" | "bad" | "muted" }> = {
	confirmed: { label: "Taken down", tone: "ok" },
	reported: { label: "Reported", tone: "wait" },
	problem: { label: "Not delivered", tone: "bad" },
	none: { label: "Not reported", tone: "muted" },
};

const TONE = {
	ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
	wait: "border-amber-200 bg-amber-50 text-amber-800",
	bad: "border-red-200 bg-red-50 text-red-800",
	muted: "border-slate-200 bg-slate-50 text-slate-600",
} as const;

function Pill({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
	return (
		<span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", TONE[tone])}>
			<span className="size-1.5 rounded-full bg-current" />
			{children}
		</span>
	);
}

function language(code?: string): string | undefined {
	return code ? LANGUAGE_NAMES[code] ?? code.toUpperCase() : undefined;
}

function duration(minutes: number): string {
	if (minutes < 120) return `${minutes} min`;
	if (minutes < 72 * 60) return `${Math.round(minutes / 60)} h`;
	return `${Math.round(minutes / 1_440)} days`;
}

function kb(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

/** `name.platform.com` as the distinctive part in full and the shared platform muted. */
function Host({ site, platform }: { site: Pick<PublicCampaignSite, "host">; platform?: string }) {
	const suffix = platform && site.host.endsWith(`.${platform}`) ? `.${platform}` : "";
	return (
		<span className="block truncate font-mono text-[13px]" title={site.host}>
			{site.host.slice(0, site.host.length - suffix.length)}
			<span className="text-muted-foreground">{suffix}</span>
		</span>
	);
}

function Hash({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<span className="inline-flex items-center gap-1 font-mono text-xs" title={value}>
			{value.slice(0, 16)}…{value.slice(-8)}
			<button
				type="button"
				className="text-muted-foreground hover:text-foreground"
				aria-label="Copy SHA-256"
				onClick={() => void navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_500); })}
			>
				{copied ? "✓" : <Copy className="size-3" />}
			</button>
		</span>
	);
}

/** The preview of a page: its trimmed screenshot, top-aligned in a tile, or whole when `whole`. */
function Preview({ site, className, whole = false }: { site: PublicCampaignSite; className?: string; whole?: boolean }) {
	const source = site.thumbnailUrl ?? site.screenshotUrl;
	return (
		<div className={cn("overflow-hidden bg-slate-100", className)}>
			{source
				// eslint-disable-next-line @next/next/no-img-element
				? <img src={source} alt={`Screenshot of ${site.host}`} loading="lazy" className={whole ? "h-auto w-full" : "size-full object-cover object-top"} />
				: <div className="flex size-full min-h-24 items-center justify-center text-xs text-muted-foreground">No screenshot</div>}
		</div>
	);
}

/** A page's time in a tile: the hour alone when the whole campaign fits in one UTC day. */
function tileTime(campaign: PublicCampaign, iso: string): string {
	const sameDay = campaign.firstSeenAt.slice(0, 10) === campaign.lastSeenAt.slice(0, 10);
	return sameDay ? `${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

function Timeline({ campaign, onOpen }: { campaign: PublicCampaign; onOpen: (index: number) => void }) {
	const start = Date.parse(campaign.firstSeenAt);
	const span = Math.max(1, Date.parse(campaign.lastSeenAt) - start);
	const rows = new Map<string, number>();
	return (
		<div className="rounded-xl border bg-card px-5 pb-3 pt-5">
			<div className="relative mx-2 h-12">
				<div className="absolute inset-x-0 top-6 h-0.5 bg-border" />
				{campaign.sites.map((site, index) => {
					const row = rows.get(site.firstSeenAt) ?? 0;
					rows.set(site.firstSeenAt, row + 1);
					const left = ((Date.parse(site.firstSeenAt) - start) / span) * 100;
					return (
						<button
							key={site.submissionId}
							type="button"
							title={`${site.host} · ${formatUtcDateTime(site.firstSeenAt)}`}
							aria-label={`Open ${site.host}`}
							onClick={() => onOpen(index)}
							className="absolute size-4 -translate-x-1/2 rounded-full border-[3px] border-background bg-red-600 shadow-[0_0_0_1px_#fca5a5] transition-transform hover:scale-125 focus-visible:scale-125 focus-visible:outline-none"
							style={{ left: `${left}%`, top: `${17 - row * 14}px` }}
						/>
					);
				})}
			</div>
			<div className="mx-2 flex justify-between text-xs text-muted-foreground">
				<span>{formatUtcDateTime(campaign.firstSeenAt)}</span>
				<span>{formatUtcDateTime(campaign.lastSeenAt)}</span>
			</div>
		</div>
	);
}

function SiteDetail({ campaign, index, onStep }: { campaign: PublicCampaign; index: number; onStep: (index: number) => void }) {
	const site = campaign.sites[index]!;
	return (
		<>
			<div className="flex items-center justify-between gap-3 border-b px-5 py-3 pr-14">
				<div className="min-w-0">
					<SheetDescription className="text-xs">Page {index + 1} of {campaign.sites.length}</SheetDescription>
					<SheetTitle className="text-sm font-normal"><Host site={site} platform={campaign.platform} /></SheetTitle>
				</div>
				<div className="flex shrink-0 gap-1.5">
					<button type="button" className="rounded-md border p-1.5 hover:bg-accent" aria-label="Previous page" onClick={() => onStep(index - 1)}><ArrowLeft className="size-4" /></button>
					<button type="button" className="rounded-md border p-1.5 hover:bg-accent" aria-label="Next page" onClick={() => onStep(index + 1)}><ArrowRight className="size-4" /></button>
				</div>
			</div>
			<div className="space-y-5 overflow-y-auto p-5">
				<div>
					<Preview site={site} className="rounded-lg border" whole />
					<p className="mt-2 text-xs text-muted-foreground">
						The phishing page as our browser captured it. Do not visit the address and never enter data there.
						{site.screenshotUrl && <> <a href={site.screenshotUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">Full capture with address and time</a></>}
					</p>
				</div>
				{site.steps.length > 1 && (
					<div>
						<h3 className="mb-1 text-sm font-semibold">The visit, page by page</h3>
						<p className="mb-3 text-xs text-muted-foreground">Our browser walked the site as a victim would, with made-up data. Each page it reached, in order; open one for the capture with address and time.</p>
						<ol className="flex snap-x gap-2 overflow-x-auto pb-2">
							{site.steps.map((step) => (
								<li key={step.step} className="w-32 shrink-0 snap-start">
									<a href={step.stampedUrl ?? step.screenshotUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border hover:ring-2 hover:ring-primary/40">
										<img src={step.screenshotUrl} alt={`Page ${step.step} of the visit to ${site.host}`} loading="lazy" className="h-24 w-full bg-muted object-cover object-top" />
									</a>
									<span className="mt-1 block text-xs text-muted-foreground">Page {step.step}</span>
								</li>
							))}
						</ol>
					</div>
				)}
				{site.verdict && (
					<div className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm">
						<h3 className="font-semibold">Why it is phishing</h3>
						<p>
							{site.verdict.basis === "credential_theft" ? "It collects sign-in credentials" : site.verdict.basis === "payment_fraud" ? "It takes payment or card data" : `Finding: ${site.verdict.finding}`}
							{site.verdict.impersonates ? `, imitating ${site.verdict.impersonates}` : ""}.
						</p>
						{site.verdict.quote && <blockquote className="border-l-2 pl-3 italic text-muted-foreground">&ldquo;{site.verdict.quote}&rdquo;</blockquote>}
						{site.verdict.fields.length > 0 && <p className="text-muted-foreground">Fields it asks for: {site.verdict.fields.join(", ")}</p>}
						{site.sent.length > 0 && (
							<ul className="space-y-1 pt-1">
								{site.sent.map((sent) => (
									<li key={`${sent.method} ${sent.url}`} className="break-all">
										Our synthetic {sent.fields.join(", ")} went to <span className="font-mono text-xs">{sent.method} {sent.url}</span>{sent.sameSite ? " (the site's own server)" : ""}.
									</li>
								))}
							</ul>
						)}
					</div>
				)}
				<dl className="grid grid-cols-[8.5rem_1fr] gap-x-4 gap-y-2 text-sm">
					<dt className="text-muted-foreground">Address</dt><dd className="break-all font-mono text-[13px]">{site.url.replace(/^http/, "hxxp")}</dd>
					<dt className="text-muted-foreground">First seen</dt><dd>{formatUtcDateTime(site.firstSeenAt)}</dd>
					{site.asks.length > 0 && <><dt className="text-muted-foreground">Asks for</dt><dd>{site.asks.join(", ")}</dd></>}
					{site.language && <><dt className="text-muted-foreground">Language seen</dt><dd>{language(site.language)}</dd></>}
				</dl>
				<div>
					<h3 className="mb-3 text-sm font-semibold">Takedown</h3>
					<ol className="space-y-3 border-l-2 pl-4">
						<li className="relative text-sm before:absolute before:-left-[1.4rem] before:top-1.5 before:size-2.5 before:rounded-full before:bg-emerald-600">
							Captured and confirmed as phishing<span className="block text-xs text-muted-foreground">{formatUtcDateTime(site.firstSeenAt)}</span>
						</li>
						{site.reports.map((report) => (
							<li key={`${report.provider}-${report.reportedAt}`} className={cn("relative text-sm before:absolute before:-left-[1.4rem] before:top-1.5 before:size-2.5 before:rounded-full", REPORT_STATE[report.state].tone === "bad" ? "before:bg-red-500" : "before:bg-emerald-600")}>
								Reported to {report.provider}: {REPORT_STATE[report.state].label}
								<span className="block text-xs text-muted-foreground">{report.reportedAt ? formatUtcDateTime(report.reportedAt) : ""}{report.ticket ? ` · ticket ${report.ticket}` : ""}</span>
							</li>
						))}
						<li className={cn("relative text-sm before:absolute before:-left-[1.4rem] before:top-1.5 before:size-2.5 before:rounded-full", site.takedown === "confirmed" ? "before:bg-emerald-600" : "before:bg-slate-300")}>
							Page taken down<span className="block text-xs text-muted-foreground">{site.takedown === "confirmed" ? "confirmed by the provider" : "not confirmed yet"}</span>
						</li>
					</ol>
				</div>
				<a href={`/submissions/${site.submissionId}`} className="inline-block text-sm text-primary hover:underline">Full analysis of this page →</a>
			</div>
		</>
	);
}

function TechnicalRecord({ campaign }: { campaign: PublicCampaign }) {
	const { technical } = campaign;
	return (
		<section className="space-y-6">
			<div>
				<h2 className="text-xl font-semibold">Technical record</h2>
				<p className="text-sm text-muted-foreground">Everything we recorded about this campaign, for investigators, providers and researchers. Every value can be checked against the evidence files below.</p>
			</div>

			<div className="space-y-2">
				<h3 className="font-semibold">Where the entered data goes</h3>
				<p className="text-sm text-muted-foreground">Observed when our browser filled the pages&apos; forms with synthetic values. Each page&apos;s visit record (<span className="font-mono text-xs">visit-record.json</span>, timestamped) documents every value entered and every request that carried one.</p>
				{technical.destinations.length ? (
					<TableShell head={["Destination", "Method", "Values received", "Pages"]}>
						{technical.destinations.map((destination) => (
							<tr key={`${destination.method} ${destination.endpoint}`}>
								<td className="break-all font-mono text-xs">{destination.endpoint}{destination.sameSite && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-sans text-[11px] font-semibold">same site</span>}</td>
								<td>{destination.method}</td>
								<td>{destination.fields.join(", ")}</td>
								<td>{destination.siteCount} / {campaign.sites.length}</td>
							</tr>
						))}
					</TableShell>
				) : <p className="text-sm text-muted-foreground">No page sent the values anywhere while we watched.</p>}
				{technical.backends.map((backend) => (
					<div key={backend.label + backend.details[0]?.[1]} className="rounded-xl border bg-card p-4">
						<p className="mb-2 font-medium">{backend.label} <span className="text-sm font-normal text-muted-foreground">· {backend.siteCount} pages</span></p>
						<dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm">
							{backend.details.map(([name, value]) => <div key={name} className="contents"><dt className="text-muted-foreground">{name}</dt><dd className="break-all font-mono text-xs leading-5">{value}</dd></div>)}
						</dl>
					</div>
				))}
				{technical.payments.length > 0 && (
					<TableShell head={["Payment account", "Kind", "Pages"]}>
						{technical.payments.map((payment) => <tr key={payment.value}><td className="break-all font-mono text-xs">{payment.value}</td><td>{payment.kind === "iban" ? "IBAN" : payment.kind}</td><td>{payment.siteCount}</td></tr>)}
					</TableShell>
				)}
			</div>

			{technical.kitFiles.length > 0 && (
				<div className="space-y-2">
					<h3 className="font-semibold">Kit files shared by the pages</h3>
					<p className="text-sm text-muted-foreground">Identical bytes on several pages. None of them is a published library (checked against jsDelivr).</p>
					<TableShell head={["SHA-256", "Size", "File", "Pages"]}>
						{technical.kitFiles.map((file) => (
							<tr key={file.sha256}><td><Hash value={file.sha256} /></td><td className="whitespace-nowrap">{kb(file.size)}</td><td className="break-all font-mono text-xs">{file.path}</td><td>{file.siteCount} / {campaign.sites.length}</td></tr>
						))}
					</TableShell>
				</div>
			)}

			{(technical.dns.length > 0 || technical.abuseContacts.length > 0) && (
				<div className="space-y-2">
					<h3 className="font-semibold">Infrastructure</h3>
					<TableShell head={["Record", "Value", "Pages"]}>
						{technical.dns.map((record) => <tr key={`${record.record}-${record.value}`}><td>{record.record}</td><td className="break-all font-mono text-xs">{record.value}</td><td>{record.siteCount}</td></tr>)}
						{technical.abuseContacts.map((contact) => <tr key={contact}><td>Abuse contact</td><td className="font-mono text-xs">{contact}</td><td /></tr>)}
					</TableShell>
				</div>
			)}

			<div className="space-y-2">
				<h3 className="font-semibold">Per page: reports and evidence files</h3>
				<p className="text-sm text-muted-foreground">Each capture is an MHTML archive, a screenshot, the screenshot with address and time stamped in, a manifest of SHA-256 hashes, and an RFC 3161 timestamp token over that manifest from an independent authority.</p>
				{campaign.sites.map((site, index) => (
					<details key={site.submissionId} className="group rounded-xl border bg-card" open={index === 0}>
						<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
							<span className="min-w-0"><Host site={site} platform={campaign.platform} /></span>
							<span className="shrink-0 text-muted-foreground">{plural(site.reports.length, "report", "reports")} · {plural(site.evidence.length, "file", "files")} <span className="inline-block transition-transform group-open:rotate-180">▾</span></span>
						</summary>
						<div className="space-y-3 border-t p-4">
							{site.reports.length > 0 && (
								<TableShell head={["Reported to", "Channel", "When", "State", "Ticket"]}>
									{site.reports.map((report) => (
										<tr key={`${report.provider}-${report.channel}`}><td>{report.provider}</td><td className="break-all font-mono text-xs">{report.channel}</td><td className="whitespace-nowrap">{report.reportedAt ? formatUtcDateTime(report.reportedAt) : "–"}</td><td><Pill tone={REPORT_STATE[report.state].tone}>{REPORT_STATE[report.state].label}</Pill></td><td className="break-all font-mono text-xs">{report.ticket ?? "–"}</td></tr>
									))}
								</TableShell>
							)}
							<TableShell head={["Evidence file", "Size", "SHA-256", ""]}>
								{site.evidence.map((file) => (
									<tr key={file.url}><td className="font-mono text-xs">{file.name}</td><td className="whitespace-nowrap">{kb(file.size)}</td><td><Hash value={file.sha256} /></td><td><a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={file.url} download><Download className="size-3" />download</a></td></tr>
								))}
							</TableShell>
						</div>
					</details>
				))}
				<a className="inline-flex items-center gap-1.5 pt-2 text-sm text-primary hover:underline" href={`/campaigns/${campaign.campaignId}/evidence.zip`}><Download className="size-4" />Download the whole evidence archive (ZIP)</a>
			</div>
		</section>
	);
}

function TableShell({ head, children }: { head: string[]; children: React.ReactNode }) {
	return (
		<div className="overflow-x-auto rounded-xl border bg-card">
			<table className="w-full text-sm [&_td]:border-t [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_th]:px-3 [&_th]:py-2">
				<thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr>{head.map((name, index) => <th key={index} className="font-semibold">{name}</th>)}</tr></thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

export function CampaignView({ campaign }: { campaign: PublicCampaign }) {
	const [view, setView] = useState<"gallery" | "table">("gallery");
	const [expanded, setExpanded] = useState(false);
	const [open, setOpen] = useState<number>();
	const sites = expanded ? campaign.sites : campaign.sites.slice(0, PREVIEW_SITES);
	const step = useCallback((index: number) => setOpen((index + campaign.sites.length) % campaign.sites.length), [campaign.sites.length]);

	useEffect(() => {
		if (open === undefined) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "ArrowRight") step(open + 1);
			if (event.key === "ArrowLeft") step(open - 1);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, step]);

	const languages = campaign.languages.map(language).filter(Boolean);
	return (
		<div className="space-y-10">
			<header className="space-y-3">
				<span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700">
					<span className="size-1.5 rounded-full bg-current" />Phishing campaign · {campaign.sites.length} pages
				</span>
				<h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{campaign.title}</h1>
				<p className="max-w-3xl text-lg text-muted-foreground">{campaign.summary}</p>
			</header>

			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Stat value={String(campaign.sites.length)} label={campaign.sites.length === 1 ? "phishing page" : "phishing pages"} />
				<Stat value={duration(campaign.durationMinutes)} label={campaign.typicalIntervalMinutes ? `from first to last · a new page every ~${duration(campaign.typicalIntervalMinutes)}` : "from first to last page"} />
				<Stat value={campaign.platform ?? `${campaign.domainCount} ${campaign.domainCount === 1 ? "domain" : "domains"}`} label={campaign.platform ? "every page is a subdomain here" : languages.length ? `languages: ${languages.join(", ")}` : "registered domains"} />
				<Stat value={`${campaign.reportedCount} / ${campaign.sites.length}`} label={`reported for takedown · ${campaign.confirmedCount} confirmed`} />
			</div>

			{campaign.sites.length > 1 && (
				<section className="space-y-3">
					<div>
						<h2 className="text-xl font-semibold">When the pages appeared</h2>
						<p className="text-sm text-muted-foreground">Each dot is one page; click it to open the page.</p>
					</div>
					<Timeline campaign={campaign} onOpen={setOpen} />
				</section>
			)}

			<section className="space-y-4">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div>
						<h2 className="text-xl font-semibold">The pages</h2>
						<p className="text-sm text-muted-foreground">Screenshots as our browser captured them. Click a page for its details and takedown history.</p>
					</div>
					<div role="tablist" aria-label="View" className="inline-flex rounded-lg bg-muted p-0.5">
						{(["gallery", "table"] as const).map((name) => (
							<button key={name} type="button" role="tab" aria-selected={view === name} onClick={() => setView(name)}
								className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-sm", view === name ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
								{name === "gallery" ? <LayoutGrid className="size-3.5" /> : <Rows3 className="size-3.5" />}{name === "gallery" ? "Gallery" : "Table"}
							</button>
						))}
					</div>
				</div>

				{view === "gallery" ? (
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{sites.map((site) => {
							const index = campaign.sites.indexOf(site);
							return (
								<button key={site.submissionId} type="button" onClick={() => setOpen(index)}
									className="group overflow-hidden rounded-xl border bg-card text-left transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
									<div className="relative">
										<Preview site={site} className="aspect-[4/3] border-b" />
										<span className="absolute left-2 top-2 rounded bg-black/75 px-1.5 text-xs font-semibold text-white">{index + 1}</span>
									</div>
									<div className="space-y-2 p-3">
										<Host site={site} platform={campaign.platform} />
										<div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
											<span className="flex min-w-0 items-center gap-1.5">
												<span className="truncate">{tileTime(campaign, site.firstSeenAt)}</span>
												{site.language && <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[11px] font-semibold text-foreground" title={language(site.language)}>{site.language.toUpperCase()}</span>}
											</span>
											<Pill tone={TAKEDOWN[site.takedown].tone}>{TAKEDOWN[site.takedown].label}</Pill>
										</div>
									</div>
								</button>
							);
						})}
					</div>
				) : (
					<TableShell head={["", "Page", "First seen", "Language", "Takedown"]}>
						{sites.map((site) => {
							const index = campaign.sites.indexOf(site);
							return (
								<tr key={site.submissionId} className="cursor-pointer hover:bg-muted/40" onClick={() => setOpen(index)}>
									<td className="w-20"><Preview site={site} className="h-12 w-[4.5rem] rounded border" /></td>
									<td className="max-w-xs"><button type="button" className="w-full text-left" onClick={() => setOpen(index)}><Host site={site} platform={campaign.platform} /></button></td>
									<td className="whitespace-nowrap">{formatUtcDateTime(site.firstSeenAt)}</td>
									<td>{language(site.language) ?? "–"}</td>
									<td><Pill tone={TAKEDOWN[site.takedown].tone}>{TAKEDOWN[site.takedown].label}</Pill></td>
								</tr>
							);
						})}
					</TableShell>
				)}

				{campaign.sites.length > PREVIEW_SITES && (
					<div className="flex justify-center">
						<button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="rounded-full border bg-background px-4 py-1.5 text-sm font-medium hover:bg-accent">
							{expanded ? "Show fewer pages" : `Show all ${campaign.sites.length} pages`}
						</button>
					</div>
				)}
			</section>

			{campaign.reasons.length > 0 && (
				<section className="space-y-3">
					<div>
						<h2 className="text-xl font-semibold">Why we think one operator runs them</h2>
						<p className="text-sm text-muted-foreground">Each of these ties the pages together on its own.</p>
					</div>
					<div className="grid gap-3 md:grid-cols-3">
						{campaign.reasons.map((reason) => {
							const Icon = REASON_ICON[reason.kind];
							return (
								<div key={reason.kind} className="rounded-xl border bg-card p-4">
									<p className="mb-1 flex items-center gap-2 font-semibold"><Icon className="size-4 text-muted-foreground" />{reason.title}</p>
									<p className="text-sm text-muted-foreground">{reason.text}</p>
								</div>
							);
						})}
					</div>
				</section>
			)}

			<TechnicalRecord campaign={campaign} />

			<Sheet open={open !== undefined} onOpenChange={(next) => { if (!next) setOpen(undefined); }}>
				<SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
					{open !== undefined && <SiteDetail campaign={campaign} index={open} onStep={step} />}
				</SheetContent>
			</Sheet>
		</div>
	);
}

function Stat({ value, label }: { value: string; label: string }) {
	return (
		<div className="rounded-xl border bg-card px-4 py-3">
			<p className="text-2xl font-bold tracking-tight">{value}</p>
			<p className="text-xs text-muted-foreground">{label}</p>
		</div>
	);
}

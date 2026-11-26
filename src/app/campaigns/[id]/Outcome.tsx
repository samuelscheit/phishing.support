import { ShieldAlert } from "lucide-react";

import { Address } from "@/components/Address";
import type { PublicCampaign, PublicCampaignSite, SiteTakedown } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n/locale";
import { COPY, type Basis } from "./copy";
import { TAKEDOWN_STYLE, takedownCounts } from "./site_facts";
import type { Finding } from "./visitor";

const LABEL = "text-[11px] font-medium uppercase tracking-wide text-muted-foreground";

/**
 * The campaign's verdict, as the case page's verdict panel: what the sites
 * are, whom they pose as, the real address against the picked fake one,
 * what they ask for, and the page's own words as evidence.
 */
export function VerdictCard({ campaign, finding, basis, shown, locale }: { campaign: PublicCampaign; finding: Finding; basis: Basis; shown: PublicCampaignSite; locale: Locale }) {
	const copy = COPY[locale];
	const { brand, kinds } = campaign.visitor;
	const n = campaign.sites.length;
	// The picked site's words, or any site's when it has none.
	const quoted = shown.verdict?.quote ? shown : campaign.sites.find((site) => site.verdict?.quote);
	return (
		<section className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
			<p className="flex items-center gap-2 text-sm font-semibold text-destructive"><ShieldAlert className="size-4 shrink-0" />{copy.verdictTitle(finding, basis)}</p>
			{brand && <p className="mt-2 text-sm">{copy.impersonates} <span className="font-medium">{brand.name}</span><span className="text-muted-foreground"> · {copy.officialSite} {brand.domain}</span></p>}
			<p className="mt-1 text-pretty text-sm text-muted-foreground">{copy.lede(n, brand?.name, basis)}</p>
			{brand && (
				<>
					<p className={`${LABEL} mt-3`}>{copy.tellApart}</p>
					{/* A long fake address wraps anywhere rather than widen the page. */}
					<dl className="mt-1 space-y-1 text-xs [&_dd]:min-w-0 [&_dd]:break-all [&_dd_*]:whitespace-normal [&_dt]:w-16 [&_dt]:shrink-0 [&_dt]:font-semibold">
						<div className="flex items-baseline gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5"><dt className="text-emerald-800">{copy.real}</dt><dd><Address url={brand.signInHost ? `https://${brand.signInHost}/` : brand.officialUrl} /></dd></div>
						<div className="flex items-baseline gap-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5"><dt className="text-red-800">{copy.fake}</dt><dd><Address url={shown.url} /></dd></div>
					</dl>
					<p className="mt-1.5 text-pretty text-xs text-muted-foreground">{brand.signInHost ? copy.ruleSignIn(brand.name, brand.signInHost) : copy.ruleGeneric(brand.name, brand.domain)}</p>
				</>
			)}
			{kinds.length > 0 && (
				<>
					<p className={`${LABEL} mt-3`}>{copy.asksFor}</p>
					<ul className="mt-1 flex flex-wrap gap-1.5 text-xs">{kinds.map((kind) => <li key={kind} className="rounded-md border bg-background px-2 py-0.5">{copy.kind[kind]}</li>)}</ul>
				</>
			)}
			{quoted?.verdict?.quote && (
				<>
					<p className={`${LABEL} mt-3`}>{copy.evidence} <span className="normal-case tracking-normal">· {copy.quoteFrom(quoted.host)}</span></p>
					<blockquote className="mt-1 border-l-2 pl-2 text-xs text-muted-foreground">“{quoted.verdict.quote}”</blockquote>
				</>
			)}
		</section>
	);
}

/** How far the takedown got, site by site: taken down, blocklisted but up, reported, not reported; and the way to every report. */
export function TakedownCard({ sites, locale, onShowReports }: { sites: PublicCampaignSite[]; locale: Locale; onShowReports: () => void }) {
	const copy = COPY[locale];
	const n = sites.length;
	const parts = takedownCounts(sites);
	const count = (state: SiteTakedown) => parts.find((part) => part.state === state)?.count ?? 0;
	const reports = sites.reduce((total, site) => total + site.reports.length, 0);
	return (
		<section className="rounded-lg border bg-card p-4">
			<div className="flex items-baseline justify-between gap-2">
				<p className="text-sm font-semibold">{copy.takedown}</p>
				{reports > 0 && <button type="button" onClick={onShowReports} className="text-xs font-medium text-primary hover:underline">{copy.reportsLink(reports)} →</button>}
			</div>
			<p className="mt-0.5 text-xs text-muted-foreground">{copy.takedownSub(count("taken_down"), n, n - count("none"))}</p>
			<div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
				{parts.map((part) => <span key={part.state} className={TAKEDOWN_STYLE[part.state].dot} style={{ flexGrow: part.count }} />)}
			</div>
			<ul className="mt-2 grid grid-cols-3 gap-2 text-xs">
				{parts.map((part) => (
					<li key={part.state}>
						<span className="block text-lg font-semibold leading-tight tabular-nums">{part.count}</span>
						<span className="flex items-start gap-1 text-muted-foreground"><span className={`mt-1 size-2 shrink-0 rounded-full ${TAKEDOWN_STYLE[part.state].dot}`} />{copy.takedownState[part.state]}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

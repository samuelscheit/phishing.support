"use client";

/**
 * The campaign's technical record for investigators, providers and
 * researchers, in English: where entered data goes, the operator's receivers
 * and payment accounts, shared kit files, infrastructure and abuse contacts
 * (the Technical tab), and per site every report and every timestamped
 * evidence file (the Evidence tab). Every value can be checked against the files.
 */
import { useCopy } from "@/components/useCopy";
import { ChevronDown, Copy, Download } from "lucide-react";

import type { PublicCampaign, PublicCampaignSite } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n/locale";
import { plural } from "@/lib/util/values";
import { cn } from "@/lib/util/cn";
import { COPY } from "./copy";

/** Said once above the English record on a page in another language. */
function EnglishOnly({ locale }: { locale: Locale }) {
	const note = COPY[locale].technicalNote;
	return note ? <p className="text-sm text-muted-foreground">{note}</p> : null;
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
	const { copied, copy } = useCopy(1_500);
	return (
		<span className="inline-flex items-center gap-1 font-mono text-xs" title={value}>
			{value.slice(0, 16)}…{value.slice(-8)}
			<button
				type="button"
				className="text-muted-foreground hover:text-foreground"
				aria-label="Copy SHA-256"
				onClick={() => void copy(value)}
			>
				{copied ? "✓" : <Copy className="size-3" />}
			</button>
		</span>
	);
}

function TableShell({ head, children }: { head: string[]; children: React.ReactNode }) {
	return (
		<div className="overflow-x-auto rounded-xl border bg-card">
			<table className="w-full min-w-[36rem] text-sm [&_td]:border-t [&_td]:px-3 [&_td]:py-2 [&_td]:align-middle [&_th]:px-3 [&_th]:py-2">
				<thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr>{head.map((name, index) => <th key={index} className="font-semibold">{name}</th>)}</tr></thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

export function TechnicalRecord({ campaign, locale }: { campaign: PublicCampaign; locale: Locale }) {
	const { technical } = campaign;
	return (
		<div lang="en" className="space-y-6">
			<EnglishOnly locale={locale} />
			<div className="space-y-2">
				<h3 className="font-semibold">Where the entered data goes</h3>
				<p className="text-sm text-muted-foreground">Observed when our browser filled the sites&apos; forms with synthetic values. Each site&apos;s visit record (<span className="font-mono text-xs">visit-record.json</span>, timestamped) documents every value entered and every request that carried one.</p>
				{technical.destinations.length ? (
					<TableShell head={["Destination", "Method", "Values received", "Sites"]}>
						{technical.destinations.map((destination) => (
							<tr key={`${destination.method} ${destination.endpoint}`}>
								<td className="break-all font-mono text-xs">{destination.endpoint}{destination.sameSite && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-sans text-[11px] font-semibold">same site</span>}</td>
								<td>{destination.method}</td>
								<td>{destination.fields.join(", ")}</td>
								<td>{destination.siteCount} / {campaign.sites.length}</td>
							</tr>
						))}
					</TableShell>
				) : <p className="text-sm text-muted-foreground">No site sent the values anywhere while we watched.</p>}
				{technical.backends.map((backend) => (
					<div key={backend.label + backend.details[0]?.[1]} className="rounded-xl border bg-card p-4">
						<p className="mb-2 font-medium">{backend.label} <span className="text-sm font-normal text-muted-foreground">· {plural(backend.siteCount, "site", "sites")}</span></p>
						<dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
							{backend.details.map(([name, value]) => <div key={name} className="contents"><dt className="text-muted-foreground">{name}</dt><dd className="break-all font-mono text-xs leading-5">{value}</dd></div>)}
						</dl>
					</div>
				))}
				{technical.deliveries.map((delivery) => (
					<div key={delivery.template} className="rounded-xl border bg-card p-4">
						<p className="mb-2 font-medium">Command visitors are made to paste <span className="text-sm font-normal text-muted-foreground">· {plural(delivery.siteCount, "site", "sites")}</span></p>
						<p className="mb-1 text-sm text-muted-foreground">Same steps on every site; the server, the path and the decoy name differ.</p>
						<pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">{delivery.template}</pre>
					</div>
				))}
				{technical.payments.length > 0 && (
					<TableShell head={["Payment account", "Kind", "Sites"]}>
						{technical.payments.map((payment) => <tr key={payment.value}><td className="break-all font-mono text-xs">{payment.value}</td><td>{payment.kind === "iban" ? "IBAN" : payment.kind}</td><td>{payment.siteCount}</td></tr>)}
					</TableShell>
				)}
			</div>

			{technical.kitFiles.length > 0 && (
				<div className="space-y-2">
					<h3 className="font-semibold">Kit files shared by the sites</h3>
					<p className="text-sm text-muted-foreground">Identical bytes on several sites. None of them is a published library (checked against jsDelivr).</p>
					<TableShell head={["SHA-256", "Size", "File", "Sites"]}>
						{technical.kitFiles.map((file) => (
							<tr key={file.sha256}><td><Hash value={file.sha256} /></td><td className="whitespace-nowrap">{kb(file.size)}</td><td className="break-all font-mono text-xs">{file.path}</td><td>{file.siteCount} / {campaign.sites.length}</td></tr>
						))}
					</TableShell>
				</div>
			)}

			{(technical.dns.length > 0 || technical.abuseContacts.length > 0) && (
				<div className="space-y-2">
					<h3 className="font-semibold">Infrastructure</h3>
					{technical.dns.length > 0 && (
						<TableShell head={["Record", "Value", "Sites"]}>
							{technical.dns.map((record) => <tr key={`${record.record}-${record.value}`}><td>{record.record}</td><td className="break-all font-mono text-xs">{record.value}</td><td>{record.siteCount}</td></tr>)}
						</TableShell>
					)}
					{technical.abuseContacts.length > 0 && (
						<>
							<h4 className="pt-2 text-sm font-semibold">Abuse contacts</h4>
							<ul className="columns-1 gap-6 break-all font-mono text-xs leading-6 sm:columns-2">{technical.abuseContacts.map((contact) => <li key={contact}>{contact}</li>)}</ul>
						</>
					)}
				</div>
			)}
		</div>
	);
}

export function EvidenceRecord({ campaign, locale }: { campaign: PublicCampaign; locale: Locale }) {
	return (
		<div lang="en" className="space-y-4">
			<EnglishOnly locale={locale} />
			<a className="inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:bg-foreground/90" href={`/campaigns/${campaign.campaignId}/evidence.zip`}><Download className="size-4" />Download the whole evidence archive (ZIP)</a>
			<div className="space-y-2">
				<h3 className="font-semibold">Per site: evidence files</h3>
				<p className="text-sm text-muted-foreground">Each capture is an MHTML archive, a screenshot, the screenshot with address and time stamped in, a manifest of SHA-256 hashes, and an RFC 3161 timestamp token over that manifest from an independent authority.</p>
				<div>
					{campaign.sites.map((site) => (
						<details key={site.key} className="group/site border-b first:border-t">
							<summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
								<span className="min-w-0"><Host site={site} platform={campaign.platform} /></span>
								<span className="flex shrink-0 items-center gap-1 text-muted-foreground">{plural(site.evidence.length, "file", "files")}<ChevronDown className="size-3.5 transition-transform group-open/site:rotate-180" /></span>
							</summary>
							<div className="border-t p-4">
								<TableShell head={["Evidence file", "Size", "SHA-256", ""]}>
									{site.evidence.map((file) => (
										<tr key={file.url}><td className="font-mono text-xs">{file.name}</td><td className="whitespace-nowrap">{kb(file.size)}</td><td><Hash value={file.sha256} /></td><td><a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={file.url} download><Download className="size-3" />download</a></td></tr>
									))}
								</TableShell>
							</div>
						</details>
					))}
				</div>
			</div>
		</div>
	);
}

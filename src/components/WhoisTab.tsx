"use client";

import * as React from "react";
import { format } from "date-fns";
import { parse as parseDomain } from "tldts";
import { Network, Server } from "lucide-react";

import type { WhoISInfo } from "@/lib/website_info";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { recursiveAbuseContact } from "../web_lib/util";

function safeFormatDate(value?: string) {
	if (!value) return null;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return value;
	return format(d, "PPP p");
}

function uniqStrings(values: Array<string | undefined | null>) {
	return Array.from(new Set(values.map((x) => (x ?? "").trim()).filter(Boolean)));
}

function KeyValueTable({ rows }: { rows: Array<{ k: string; v?: React.ReactNode }> }) {
	const filtered = rows.filter((r) => r.v !== undefined && r.v !== null && r.v !== "");
	if (filtered.length === 0) return <div className="text-sm text-muted-foreground">No data available.</div>;

	return (
		<div className="rounded-md border bg-background">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-36 min-w-36">Field</TableHead>
						<TableHead>Value</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{filtered.map((row) => (
						<TableRow key={row.k}>
							<TableCell className="font-medium text-muted-foreground min-w-36 w-36">{row.k}</TableCell>
							<TableCell className="break-all">
								<pre>{row.v}</pre>
								{/* {row.v} */}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function ListBadges({ items }: { items: string[] }) {
	if (!items.length) return <div className="text-sm text-muted-foreground">—</div>;
	return (
		<div className="flex flex-wrap gap-2">
			{items.map((item) => (
				<Badge key={item} variant="outline" className="font-mono text-[11px]">
					{item}
				</Badge>
			))}
		</div>
	);
}

export function WhoisTab({ url, whois }: { url?: string | null; whois?: WhoISInfo | null }) {
	let hostname: string | null = null;
	try {
		hostname = url ? new URL(url).hostname : null;
	} catch {
		hostname = null;
	}

	const domainParts = hostname ? parseDomain(hostname) : null;
	const registrableDomain = domainParts?.domain ?? null;
	const publicSuffix = domainParts?.publicSuffix ?? null;

	const rdap = whois?.rdap;
	const dns = whois?.dns;
	const ipRdaps = whois?.ip_rdaps ?? [];

	const registrarAbuseEmail = rdap?.registrar ? recursiveAbuseContact(rdap.registrar)?.email : undefined;

	return (
		<div className="space-y-4">
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<Server className="h-4 w-4" />
						Domain
					</CardTitle>
				</CardHeader>
				<CardContent>
					<KeyValueTable
						rows={[
							{ k: "URL Hostname", v: hostname ?? undefined },
							{ k: "Registrable Domain", v: registrableDomain ?? undefined },
							{ k: "Public Suffix", v: publicSuffix ?? undefined },
							{ k: "Domain", v: rdap?.domain },
							{ k: "Registrar", v: rdap?.registrar?.vcard?.org || rdap?.registrar?.vcard?.fn || rdap?.registrar?.handle },
							{ k: "Registrar Abuse", v: registrarAbuseEmail },
							{ k: "Created", v: safeFormatDate(rdap?.events?.registration) },
							{ k: "Updated", v: safeFormatDate(rdap?.events?.["last changed"]) },
							{ k: "Expires", v: safeFormatDate(rdap?.events?.expiration) },
						]}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<Network className="h-4 w-4" />
						DNS Records
					</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					<KeyValueTable
						rows={[
							{ k: "A", v: (dns?.A ?? []).length ? <ListBadges items={dns?.A ?? []} /> : undefined },
							{ k: "AAAA", v: (dns?.AAAA ?? []).length ? <ListBadges items={dns?.AAAA ?? []} /> : undefined },
							{ k: "CNAME", v: (dns?.CNAME ?? []).length ? <ListBadges items={dns?.CNAME ?? []} /> : undefined },
							{ k: "NS", v: (dns?.NS ?? []).length ? <ListBadges items={dns?.NS ?? []} /> : undefined },
							{
								k: "MX",
								v: (dns?.MX ?? []).length ? (
									<ListBadges items={(dns?.MX ?? []).map((mx) => `${mx.exchange} (prio ${mx.priority})`)} />
								) : undefined,
							},
							{ k: "TXT", v: (dns?.TXT ?? []).length ? <ListBadges items={dns?.TXT ?? []} /> : undefined },
						]}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<Network className="h-4 w-4" />
						IP Information
					</CardTitle>
				</CardHeader>
				<CardContent>
					{ipRdaps.length ? (
						<div className="space-y-3">
							{ipRdaps.map((ip) => (
								<Card key={`${ip.ip}-${ip.handle}`}>
									<CardHeader className="space-y-1">
										<CardTitle className="font-mono text-sm">{ip.ip}</CardTitle>
										<div className="text-[11px] text-muted-foreground break-all">
											{ip.name || ip.handle || "—"}
											{ip.country ? ` \u00b7 ${ip.country}` : ""}
											{ip.type ? ` \u00b7 ${ip.type}` : ""}
										</div>
									</CardHeader>
									<CardContent>
										<KeyValueTable
											rows={[
												{ k: "Handle", v: ip.handle },
												{ k: "Start", v: ip.startAddress },
												{ k: "End", v: ip.endAddress },
												{
													k: "CIDR",
													v: (ip.cidr0_cidrs ?? []).length
														? (ip.cidr0_cidrs ?? [])
																.map((c) =>
																	c.v4prefix
																		? `${c.v4prefix}/${c.length}`
																		: c.v6prefix
																			? `${c.v6prefix}/${c.length}`
																			: null
																)
																.filter(Boolean)
																.join(", ")
														: undefined,
												},
												{ k: "Port43", v: ip.port43 },
												{ k: "Abuse contact", v: ip.abuse?.email || ip.abuse?.tel || undefined },
												{ k: "Registered", v: safeFormatDate(ip.events?.registration) },
												{ k: "Last changed", v: safeFormatDate(ip.events?.["last changed"]) },
												{ k: "Remarks", v: ip.remarks || ip.abuse?.remarks },
											]}
										/>
										{(ip.origin_asns ?? []).length ? (
											<div className="mt-4 space-y-3">
												<div className="text-sm font-medium">BGP Origin ASN</div>
												{ip.origin_asns.map((origin) => (
													<Card key={`${ip.ip}-AS${origin.asn}`}>
														<CardHeader className="space-y-1">
															<CardTitle className="font-mono text-sm">AS{origin.asn}</CardTitle>
															<div className="text-[11px] text-muted-foreground break-all">
																{origin.rdap?.name || origin.rdap?.handle || "RDAP details unavailable"}
															</div>
														</CardHeader>
														<CardContent>
															<KeyValueTable
																rows={[
																	{ k: "BGP prefix", v: origin.prefix },
																	{ k: "Origin source", v: "RIPEstat" },
																	{ k: "RDAP handle", v: origin.rdap?.handle },
																	{ k: "Abuse contact", v: origin.rdap?.abuse?.email || origin.rdap?.abuse?.tel },
																	{ k: "Registered", v: safeFormatDate(origin.rdap?.events?.registration) },
																	{ k: "Last changed", v: safeFormatDate(origin.rdap?.events?.["last changed"]) },
																]}
															/>
														</CardContent>
													</Card>
												))}
											</div>
										) : null}
									</CardContent>
								</Card>
							))}
						</div>
					) : (
						<div className="text-sm text-muted-foreground">No IP RDAP information available.</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

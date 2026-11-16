"use client";

import * as React from "react";
import { parse as parseDomain } from "tldts";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/web_lib/util";

type UrlPartsProps = {
	url: string;
	className?: string;
	maxPathSegments?: number;
	maxQueryParams?: number;
};

type TooltipDetails = {
	title: string;
	description: string;
	example?: string | null;
};

type UrlPartDetails = {
	id: "protocol" | "subdomain" | "domain" | "path";
	value: string;
	tooltip: TooltipDetails;
};

function TooltipDetailsContent({ title, description, example }: TooltipDetails) {
	return (
		<div className="max-w-85 space-y-1.5 py-1">
			<div className="text-sm font-semibold leading-none" dangerouslySetInnerHTML={{ __html: title }} />
			{example ? (
				<div className="py-1">
					<div className="text-[10px] opacity-80">Example</div>
					<div className="mt-1 rounded-sm bg-gray-200 px-2 py-1 font-mono text-[11px]">{example}</div>
				</div>
			) : null}
			<div
				className="text-[12px] opacity-90 leading-snug font-sans whitespace-break-spaces"
				dangerouslySetInnerHTML={{
					__html: description.replace(/\n/g, "<br/>"),
				}}
			/>
		</div>
	);
}

function Part({ tooltip, children, className }: { tooltip: TooltipDetails; children: React.ReactNode; className?: string }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className={cn("font-mono text-[14px] font-normal", className)}>{children}</span>
			</TooltipTrigger>
			<TooltipContent side="top" align="center" className="bg-gray-100 text-foreground">
				<TooltipDetailsContent {...tooltip} />
			</TooltipContent>
		</Tooltip>
	);
}

function UrlPartsDetailsTable({ parts }: { parts: UrlPartDetails[] }) {
	return (
		<div className="mt-3 overflow-x-auto rounded-md border bg-background -ml-[13px] w-[calc(100%+58px)] ">
			<table className="w-full text-left text-[12px] h-1">
				<thead className="border-b bg-muted/50">
					<tr>
						<th scope="col" className="px-3 py-2 text-center font-semibold text-foreground">
							Part
						</th>
						<th scope="col" className="px-3 py-2 font-semibold text-foreground pl-0">
							Description
						</th>
					</tr>
				</thead>
				<tbody>
					{parts.map((part) => (
						<tr key={part.id} className="border-b last:border-b-0">
							<td className="px-1 text-center h-full whitespace-break-spaces text-foreground w-24 max-w-24 text-xs flex flex-col gap-1 py-1">
								<span className="text-black text-xs">{part.tooltip.title}</span>
								<div className="font-mono flex-1 justify-center flex items-end text-blue-900">{part.value}</div>
							</td>
							<td className="align-top py-1">
								<div
									className="leading-snug text-foreground/90 whitespace-break-spaces"
									dangerouslySetInnerHTML={{
										__html: part.tooltip.description.replace(/\n/g, "<br/>"),
									}}
								/>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function UrlParts({ url, className }: UrlPartsProps) {
	const [showDetailsTable, setShowDetailsTable] = React.useState(false);

	React.useEffect(() => {
		const mediaQuery = window.matchMedia("(hover: none) and (pointer: coarse)");
		const update = () => setShowDetailsTable(mediaQuery.matches);
		update();
		mediaQuery.addEventListener("change", update);
		return () => mediaQuery.removeEventListener("change", update);
	}, []);

	let parsedUrl: URL | null = null;
	try {
		parsedUrl = new URL(url);
	} catch {
		parsedUrl = null;
	}

	if (!parsedUrl) {
		return <div className={cn("font-mono text-xs", className)}>{url}</div>;
	}

	const protocol = parsedUrl.protocol.replace(":", "");

	const pathWithQuery = `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
	const { domainWithoutSuffix, domain, publicSuffix, subdomain } = parseDomain(parsedUrl.hostname);
	const mainDomain = domain ?? parsedUrl.hostname;

	const subdomainTooltip: TooltipDetails = {
		title: "Sub\u00ADdomain",
		description: `A subdomain is just extra text before the main domain (${mainDomain}).\nAttackers often put trusted brand names here to mislead you.\nIgnore it!\n\n<strong>Always verify the main domain</strong>:\nthe last word "${domainWithoutSuffix}" before .${publicSuffix}`,
		example: subdomain + ".",
	};

	const domainTooltip: TooltipDetails = {
		title: "Main domain name",
		description:
			"It should match exactly the site you expect.\nAttackers often use similar-looking domains to trick you.\n\n<strong>This is the most important part to verify when checking a URL</strong>",
		example: mainDomain,
	};

	const protocolTooltip: TooltipDetails = {
		title: "Proto\u00ADcol",
		description: `How the browser should connect. HTTPS is encrypted; HTTP is not.\n\n<strong>HTTPS does NOT mean the site is safe to use!</strong>`,
		example: protocol,
	};

	const pathTooltip: TooltipDetails = {
		title: "Path",
		description:
			"Everything after the main domain (the /... part).\nIrrelevant for identifying the site owner.\n\nAttackers may use long or confusing paths to hide the true nature of the site.",
		example: pathWithQuery,
	};

	const partsForTable: UrlPartDetails[] = [
		{ id: "protocol", value: protocol + "://", tooltip: protocolTooltip },
		...(subdomain ? [{ id: "subdomain" as const, value: subdomain + ".", tooltip: subdomainTooltip }] : []),
		{ id: "domain", value: mainDomain, tooltip: domainTooltip },
		{ id: "path", value: pathWithQuery, tooltip: pathTooltip },
	];

	return (
		<TooltipProvider delayDuration={0} skipDelayDuration={0}>
			<div className={cn("w-full", className)}>
				<div className="flex flex-wrap items-center gap-1">
					<Part tooltip={protocolTooltip} className="text-muted-foreground">
						{protocol}
					</Part>
					<span className="text-muted-foreground">://</span>

					{subdomain ? (
						<>
							<Part tooltip={subdomainTooltip} className="text-muted-foreground">
								{subdomain}
							</Part>
							<span className="text-muted-foreground">.</span>
						</>
					) : null}

					<Part tooltip={domainTooltip}>{mainDomain}</Part>

					{pathWithQuery ? (
						<Part tooltip={pathTooltip} className="text-muted-foreground">
							{pathWithQuery}
						</Part>
					) : null}
				</div>
				{showDetailsTable ? <UrlPartsDetailsTable parts={partsForTable} /> : null}
			</div>
		</TooltipProvider>
	);
}

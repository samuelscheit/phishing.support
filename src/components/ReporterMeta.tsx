"use client";

import { cn } from "@/web_lib/util";
import {
	countryFlag,
	countryName,
	getReporterHeader,
	hasReporterHeaders,
	readableUserAgent,
	type ReporterMetadata,
} from "@/web_lib/reporter";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type ReporterMetaProps = ReporterMetadata & {
	className?: string;
};

/** Compact, accessible attribution for a web submission. */
export function ReporterMeta({ reporterCountry, reporterHeaders, className }: ReporterMetaProps) {
	const device = readableUserAgent(reporterHeaders);
	const flag = countryFlag(reporterCountry);
	const fullCountryName = countryName(reporterCountry);

	// Do not add an empty attribution row to older submissions created before
	// reporter metadata was persisted.
	if (!hasReporterHeaders(reporterHeaders) && !fullCountryName) return null;

	return (
		<TooltipProvider delayDuration={0} skipDelayDuration={0}>
			<div
				className={cn("flex min-w-0 items-center gap-1 text-xs text-muted-foreground", className)}
				aria-label={`Reported by ${device}${fullCountryName ? ` from ${fullCountryName}` : ""}`}
				data-testid="reporter-meta"
			>
				<span className="shrink-0">Reported by</span>
				<span className="truncate" title={getReporterHeader(reporterHeaders, "user-agent")}>
					{device}
				</span>
				{fullCountryName && flag ? (
					<>
						<span className="shrink-0">from</span>
						<Tooltip>
							<TooltipTrigger asChild>
								<span
									className="cursor-help text-base leading-none"
									role="img"
									aria-label={fullCountryName}
									title={fullCountryName}
									tabIndex={0}
								>
									{flag}
								</span>
							</TooltipTrigger>
							<TooltipContent side="top">{fullCountryName}</TooltipContent>
						</Tooltip>
					</>
				) : null}
			</div>
		</TooltipProvider>
	);
}

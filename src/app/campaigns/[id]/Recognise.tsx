import { Address } from "@/components/Address";
import type { PublicCampaignSite, PublicCampaignVisitor } from "@/lib/campaign/public_view";
import type { Locale } from "@/lib/i18n/locale";
import { COPY } from "./copy";

/**
 * How to tell the fakes apart: the brand's real address against fake ones
 * from this campaign, under the one rule that tells them apart. The strict
 * sign-in rule only when the brand's sign-in host is known and validated;
 * otherwise a rule that cannot call a real address fake.
 */
export function Recognise({ brand, fakes, locale }: { brand: NonNullable<PublicCampaignVisitor["brand"]>; fakes: PublicCampaignSite[]; locale: Locale }) {
	const copy = COPY[locale];
	const real = brand.signInHost ? `https://${brand.signInHost}/` : brand.officialUrl;
	return (
		<section className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_16rem] md:gap-x-8">
			<div className="max-w-3xl space-y-6">
				<div className="space-y-1">
					<h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{copy.recognise}</h2>
					<p className="text-pretty text-muted-foreground">{copy.recogniseSub(brand.name)}</p>
				</div>
				<div className="space-y-3">
					<p className="font-medium">
						{brand.signInHost
							? <>{copy.ruleLead} <code className="rounded bg-muted px-1 font-mono text-sm">https://</code> {copy.ruleMid} <code className="rounded bg-muted px-0.5 font-mono text-sm">/</code>. {copy.ruleSignIn(brand.name, brand.signInHost)}</>
							: copy.ruleGeneric(brand.name, brand.domain)}
					</p>
					<dl className="grid grid-cols-[minmax(0,1fr)] gap-2 text-sm [&_dd]:min-w-0 [&_dt]:shrink-0 [&_dt]:font-semibold sm:[&_dt]:w-20">
						<div className="flex flex-col gap-0.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
							<dt className="text-emerald-800">{copy.real}</dt>
							<dd><Address url={real} /></dd>
						</div>
						{fakes.map((site) => (
							<div key={site.key} className="flex flex-col gap-0.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
								<dt className="text-red-800">{copy.fake}</dt>
								<dd><Address url={site.url} /></dd>
							</div>
						))}
					</dl>
				</div>
			</div>
		</section>
	);
}

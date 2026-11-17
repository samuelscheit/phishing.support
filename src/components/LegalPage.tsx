import React from "react";

import SiteLayout from "@/components/SiteLayout";

/** The operator as the legal pages name him. */
export const OPERATOR = {
	name: "Samuel Scheit",
	street: "Keplerstraße 23",
	city: "85609 Aschheim",
	country: "Deutschland",
	email: "support@phishing.support",
} as const;

export function OperatorAddress() {
	return (
		<address className="not-italic">
			{OPERATOR.name}
			<br />
			{OPERATOR.street}
			<br />
			{OPERATOR.city}
			<br />
			{OPERATOR.country}
			<br />
			E-Mail:{" "}
			<a href={`mailto:${OPERATOR.email}`} className="underline hover:text-primary">
				{OPERATOR.email}
			</a>
		</address>
	);
}

/** A German legal text with its English pointer, in the site's frame. */
export function LegalPage({ title, englishNote, children }: { title: string; englishNote: string; children: React.ReactNode }) {
	return (
		<SiteLayout>
			<article lang="de" className="container mx-auto max-w-2xl space-y-6 text-muted-foreground [&_h2]:pt-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:font-semibold [&_h3]:text-foreground [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6">
				<h1 className="text-3xl font-semibold text-foreground">{title}</h1>
				<p lang="en" className="text-sm italic">{englishNote}</p>
				{children}
			</article>
		</SiteLayout>
	);
}

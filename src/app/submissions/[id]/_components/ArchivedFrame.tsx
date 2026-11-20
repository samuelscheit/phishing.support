import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** A sandboxed iframe card for an archived page or email. */
export function ArchivedFrame({ title, date, subtitle, warning, html, error }: { title: string; date: string; subtitle?: ReactNode; warning: string; html: string | null; error: string | null }) {
	return (
		<Card className="overflow-hidden">
			<CardHeader className="py-3">
				<CardTitle className="text-sm flex flex-row items-center gap-2">
					{title}
					<div className="text-xs text-muted-foreground font-normal">(from {date})</div>
				</CardTitle>
				{subtitle ? <div className="text-xs text-muted-foreground">{subtitle}</div> : null}
				<CardDescription className="text-xs flex flex-row gap-8">
					<div className="text-zinc-500 font-semibold font-mono">{warning}</div>
				</CardDescription>
			</CardHeader>
			<CardContent className="p-0">
				{error ? (
					<div className="p-4 text-sm text-muted-foreground">{error}</div>
				) : html ? (
					<iframe title={title} srcDoc={html} className="w-full h-[70vh] bg-background" sandbox="" referrerPolicy="no-referrer" />
				) : (
					<div className="p-4 text-sm text-muted-foreground">Rendering…</div>
				)}
			</CardContent>
		</Card>
	);
}

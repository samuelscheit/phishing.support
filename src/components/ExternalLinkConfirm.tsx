"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export type ExternalLinkConfirmProps = {
	href: string;
	trigger: React.ReactNode;
	title?: string;
	description?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	openInNewTab?: boolean;
	showUrl?: boolean;
	disabled?: boolean;
};

export function ExternalLinkConfirm({
	href,
	trigger,
	description,
	confirmLabel = "Open Site",
	cancelLabel = "Cancel",
	disabled = false,
}: ExternalLinkConfirmProps) {
	const [open, setOpen] = React.useState(false);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild disabled={disabled}>
				{trigger}
			</DialogTrigger>
			<DialogContent className="bg-red-700 text-white border-red-500">
				<DialogHeader>
					<DialogTitle className="text-center">Warning</DialogTitle>
					<DialogDescription className="text-white text-center">
						This will open <span className="font-mono font-semibold">{href}</span> in a new tab.
						{description && <p className="mt-2">{description}</p>}
					</DialogDescription>
				</DialogHeader>

				<div className="flex justify-center items-center">
					<span className="font-extrabold bg-white p-4 text-red-500">DO NOT ENTER ANY SENSITIVE INFORMATION</span>
				</div>

				<DialogFooter className="justify-between flex flex-row sm:justify-between">
					<Button variant="ghost" onClick={() => setOpen(false)}>
						{cancelLabel}
					</Button>
					<Button
						asChild
						variant="secondary"
						onClick={() => {
							setOpen(false);
						}}
					>
						<a href={href} target="_blank" rel="noreferrer" className="shrink-0">
							{confirmLabel}
						</a>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

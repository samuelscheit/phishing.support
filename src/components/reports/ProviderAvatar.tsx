"use client";

import { useState } from "react";

import { cn } from "@/lib/util/cn";

const AVATAR_COLOURS = ["bg-orange-500", "bg-blue-700", "bg-slate-800", "bg-cyan-700", "bg-slate-500", "bg-violet-600", "bg-emerald-700", "bg-rose-600"];

/** "Sollutium-NL" → "SN", "Cloudflare" → "CL". */
function initialsOf(name: string): string {
	const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
	return (words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

/**
 * A company's badge, the same on every page: its website's icon, served from
 * our origin, on a light tile with a hairline edge so a dark or transparent
 * icon reads on either theme; until the icon is fetched, or when it fails
 * to load, its initials on a colour of its own.
 */
const SIZES = {
	/** A row's badge: 32 px, the icon at 20 px. */
	regular: { tile: "size-8 rounded-lg text-xs", image: "size-5", edge: 20 },
	/** Next to a page title: 44 px, the icon at 28 px. */
	large: { tile: "size-11 rounded-xl text-sm", image: "size-7", edge: 28 },
} as const;

export function ProviderAvatar({ name, icon, size = "regular" }: { name: string; icon: string | null; size?: keyof typeof SIZES }) {
	const [failed, setFailed] = useState<string | null>(null);
	const { tile, image, edge } = SIZES[size];
	if (icon && failed !== icon) {
		return (
			<span className={cn("grid shrink-0 place-items-center bg-white ring-1 ring-black/10 ring-inset dark:ring-white/15", tile)} aria-hidden>
				{/* eslint-disable-next-line @next/next/no-img-element -- a 64 px PNG of our own; nothing to optimise */}
				<img src={icon} alt="" width={edge} height={edge} className={cn("object-contain", image)} loading="lazy" decoding="async" onError={() => setFailed(icon)} />
			</span>
		);
	}
	const hash = [...name].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7);
	return <span className={cn("grid shrink-0 place-items-center font-bold tracking-normal text-white", tile, AVATAR_COLOURS[hash % AVATAR_COLOURS.length])} aria-hidden>{initialsOf(name)}</span>;
}

"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/util/cn";

/**
 * A list in a box that shows its first `rows` items whole and `peek` pixels
 * of the next one under a fade, so the cut always falls inside an item, with
 * the button that reveals the rest inside the box: over the fade while
 * collapsed, at the box's foot once expanded. Controlled when `expanded` is given.
 */
export function Collapsible({ rows, peek, count, more, less, expanded, onExpandedChange, as: List = "ul", listClassName, children }: {
	rows: number;
	peek: number;
	count: number;
	more: string;
	less: string;
	expanded?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
	as?: "ul" | "ol";
	listClassName?: string;
	children: React.ReactNode;
}) {
	const [own, setOwn] = useState(false);
	const isExpanded = expanded ?? own;
	const toggle = () => (onExpandedChange ?? setOwn)(!isExpanded);
	const list = useRef<HTMLOListElement & HTMLUListElement>(null);
	const [height, setHeight] = useState<number>();
	const collapsible = count > rows;
	const collapsed = collapsible && !isExpanded;
	// Measured whenever any item changes size (an item opens, text wraps, a font loads), not only on mount.
	useLayoutEffect(() => {
		const element = list.current;
		if (!element) return;
		const measure = () => {
			const row = element.children[rows] as HTMLElement | undefined;
			setHeight(row ? row.offsetTop + Math.min(peek, row.offsetHeight) : undefined);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		for (const child of element.children) observer.observe(child);
		return () => observer.disconnect();
	}, [rows, peek, count]);
	// Items cut off under the fade leave the tab order and the accessibility tree until the box opens.
	useLayoutEffect(() => {
		const element = list.current;
		if (!element) return;
		Array.from(element.children).forEach((child, index) => child.toggleAttribute("inert", collapsed && index >= rows));
	}, [collapsed, rows, count]);
	const button = (
		<button type="button" aria-expanded={isExpanded} onClick={toggle} className="pointer-events-auto inline-flex items-center gap-1.5 rounded-xl border bg-background px-4 py-1.5 text-left text-sm font-medium shadow-sm hover:bg-accent">
			{isExpanded ? less : more}<ChevronDown className={cn("size-4 shrink-0 transition-transform", isExpanded && "rotate-180")} />
		</button>
	);
	return (
		<div className="relative overflow-hidden rounded-xl border bg-card">
			<List ref={list} className={cn("relative overflow-hidden", listClassName)} style={collapsed && height ? { maxHeight: height } : undefined}>{children}</List>
			{collapsible && (collapsed
				? <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-28 items-end justify-center bg-gradient-to-t from-card from-40% to-transparent px-4 pb-3">{button}</div>
				: <div className="flex justify-center border-t px-4 py-3">{button}</div>)}
		</div>
	);
}

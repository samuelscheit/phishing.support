"use client";

import { useCallback, useEffect, useRef, useState } from "react";

async function writeClipboard(text: string) {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const textarea = document.createElement("textarea");
	textarea.value = text;
	document.body.appendChild(textarea);
	textarea.select();
	document.execCommand("copy");
	textarea.remove();
}

/** Copies text to the clipboard (with an execCommand fallback); `copied` stays true briefly afterwards. */
export function useCopy(resetMs = 1_800) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const copy = useCallback(async (text: string) => {
		try {
			await writeClipboard(text);
			setCopied(true);
			window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), resetMs);
		} catch (error) {
			console.error("copy failed", error);
			setCopied(false);
		}
	}, [resetMs]);
	return { copied, copy };
}

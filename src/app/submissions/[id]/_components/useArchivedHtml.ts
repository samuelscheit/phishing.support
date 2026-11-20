"use client";

import { useEffect, useState } from "react";

/** Wraps the body in a minimal doc to keep email styles from leaking. */
function sanitizeHtmlForIframe(rawHtml: string): string {
	try {
		const doc = new DOMParser().parseFromString(rawHtml, "text/html");
		return `<!doctype html><html><head><meta charset="utf-8" /><meta name="referrer" content="no-referrer" /></head><body>${doc.body.innerHTML}</body></html>`;
	} catch {
		return rawHtml;
	}
}

async function mhtmlToHtml(bytes: Uint8Array): Promise<string> {
	const { convert } = await import("mhtml-to-html/browser");
	const { data } = await convert(bytes, { enableScripts: false, fetchMissingResources: false });
	return data;
}

async function emlToHtml(bytes: Uint8Array): Promise<string> {
	const { default: PostalMime } = await import("postal-mime");
	const parsed: any = await new PostalMime().parse(bytes);
	const raw =
		(parsed?.html as string | undefined) ||
		(typeof parsed?.text === "string" && parsed.text.trim().length > 0
			? `<!doctype html><html><head><meta charset="utf-8" /></head><body><pre style="white-space:pre-wrap; overflow-wrap:anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${parsed.text
					.replace(/&/g, "&amp;")
					.replace(/</g, "&lt;")
					.replace(/>/g, "&gt;")}</pre></body></html>`
			: "");
	if (!raw) throw new Error("No HTML/text content in EML");
	return sanitizeHtmlForIframe(raw);
}

const SOURCES = {
	website: { label: "MHTML", missing: "No website snapshot (MHTML) artifact found.", failed: "Failed to render website snapshot.", log: "Failed to render website snapshot:", render: mhtmlToHtml },
	email: { label: "EML", missing: "No email (.eml) artifact found.", failed: "Failed to render email.", log: "Failed to render email:", render: emlToHtml },
} as const;

/** Fetches a stored artifact and renders it to sandboxable HTML; `artifactId` undefined reports the missing artifact. */
export function useArchivedHtml(kind: keyof typeof SOURCES, enabled: boolean, artifactId: string | number | bigint | undefined) {
	const [html, setHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setHtml(null);
		setError(null);
		if (!enabled) return;
		const source = SOURCES[kind];
		if (!artifactId) {
			setError(source.missing);
			return;
		}
		(async () => {
			try {
				const res = await fetch(`/api/artifacts/${artifactId}`);
				if (!res.ok) throw new Error(`Failed to fetch ${source.label}: ${res.status}`);
				const rendered = await source.render(new Uint8Array(await res.arrayBuffer()));
				if (!cancelled) setHtml(rendered);
			} catch (err) {
				console.error(source.log, err);
				if (!cancelled) setError(source.failed);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [kind, enabled, artifactId]);

	return { html, error };
}

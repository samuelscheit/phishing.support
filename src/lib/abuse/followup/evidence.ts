import { createHash } from "node:crypto";
import { parse, type HTMLElement } from "node-html-parser";

import { userAgent as browserUserAgent } from "../../constants";
import { capturedDocumentContent } from "../../website_archive";
import { encodedPayloadToken, extractPasteCommands, type PasteCommand } from "../../malware/paste_commands";
import { defangCommand } from "../../malware/defang";
import { downloaderUserAgent, fetchCommandPayload, type FetchedPayload } from "../../malware/payload_fetch";
import { payloadLookupUrl } from "../../malware/payload_evidence";

export type LiveCheck = { url: string; userAgent: string; as: string; status: number | "error"; bytes?: number; sha256?: string };

/**
 * Facts a provider reviewer needs to find reported content they could not
 * see: a fresh check from our server, where on the page the content sits,
 * and exact commands that show it. Everything here is measured, not written
 * by a model; a reply's narrative may only restate it.
 */
export type DecisionEvidence = {
	checkedAt: string;
	/** What our server received just now, per URL and User-Agent. */
	liveChecks: LiveCheck[];
	/** Page text around the reported command, as a visitor reads it. */
	pageContext?: string;
	/** The element that holds the command when it is a dialog a visitor must open, e.g. `div.install-modal[role=dialog]`. */
	dialog?: string;
	/** The command the page shows, defanged, and what it decodes to. */
	command?: { shown: string; decoded: string[] };
	/** Shell commands a reviewer can paste to see the content; none of them runs it. */
	reproduction: string[];
	references: string[];
};

export type EvidenceFetcher = (url: string, userAgent: string) => Promise<FetchedPayload>;

const defaultFetcher: EvidenceFetcher = (url, userAgent) => fetchCommandPayload(url, [], { userAgent });

/** One request, recorded as the reviewer would see it; the body is returned separately. */
async function check(fetcher: EvidenceFetcher, url: string, userAgent: string, as: string): Promise<{ check: LiveCheck; body?: Buffer }> {
	try {
		const fetched = await fetcher(url, userAgent);
		return {
			check: { url, userAgent, as, status: 200, bytes: fetched.body.byteLength, sha256: createHash("sha256").update(fetched.body).digest("hex") },
			body: fetched.body,
		};
	} catch (error) {
		const status = /HTTP (\d{3})/.exec(error instanceof Error ? error.message : "")?.[1];
		return { check: { url, userAgent, as, status: status ? Number(status) : "error" } };
	}
}

/** The visitor-readable lines before and after the command, with the command itself marked. */
function contextAround(text: string, command: PasteCommand): string | undefined {
	const lines = text.split(/\r?\n/);
	const index = lines.findIndex((line) => line.replace(/\s+/g, " ").includes(command.shown.slice(0, 40)));
	if (index < 0) return undefined;
	return lines.slice(Math.max(0, index - 6), index + 3).map((line, offset) => (offset === Math.min(6, index) ? "[the command]" : line)).join("\n");
}

const DIALOG_MARKER = /\b(?:modal|dialog|popup|pop-up|overlay|lightbox|drawer)\b/i;

function describeElement(element: HTMLElement): string {
	const id = element.getAttribute("id");
	const classes = (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2);
	const role = element.getAttribute("role");
	return `${element.tagName.toLowerCase()}${id ? `#${id}` : ""}${classes.map((name) => `.${name}`).join("")}${role ? `[role=${role}]` : ""}`;
}

/**
 * The dialog the command sits in, when it does: a reviewer who loads the page
 * sees the page around it, not the command, until the dialog is opened.
 */
function dialogHolding(html: string, command: PasteCommand): string | undefined {
	const needle = command.shown.slice(0, 30);
	const holder = parse(html).querySelectorAll("code, pre, textarea, input, span, div, p")
		.find((element) => element.childNodes.length > 0 && element.text.replace(/\s+/g, " ").includes(needle) && !element.querySelector("code, pre, textarea"));
	for (let element: HTMLElement | null = holder ?? null; element; element = element.parentNode as HTMLElement | null) {
		if (!element.tagName) break;
		if (element.tagName.toLowerCase() === "dialog" || element.getAttribute("role") === "dialog" || element.getAttribute("aria-modal") === "true"
			|| DIALOG_MARKER.test(`${element.getAttribute("class") ?? ""} ${element.getAttribute("id") ?? ""}`)) {
			return describeElement(element);
		}
	}
	return undefined;
}

async function payloadChecks(fetcher: EvidenceFetcher, url: string, agent: string): Promise<{ checks: LiveCheck[]; reproduction: string[] }> {
	const served = await check(fetcher, url, agent, "the command's own downloader");
	const browser = await check(fetcher, url, browserUserAgent, "a desktop browser");
	return {
		checks: [served.check, browser.check],
		reproduction: [
			`curl -s -A "${agent}" -o payload.bin "${url}" && shasum -a 256 payload.bin`,
			`curl -s -o /dev/null -w "%{http_code}\\n" -A "${browserUserAgent}" "${url}"`,
		],
	};
}

/** A malware page that tells visitors to paste a command: fetch it as a browser would and find the command again. */
async function pageEvidence(pageUrl: string, fetcher: EvidenceFetcher): Promise<Omit<DecisionEvidence, "checkedAt" | "references">> {
	const page = await check(fetcher, pageUrl, browserUserAgent, "a desktop browser");
	const liveChecks = [page.check];
	if (!page.body) return { liveChecks, reproduction: [] };
	const text = capturedDocumentContent(page.body.toString("utf8")).text;
	const [command] = extractPasteCommands(text);
	if (!command) return { liveChecks, reproduction: [] };
	const token = encodedPayloadToken(command);
	const reproduction = [token
		// The token's first characters encode the command's fixed start, so they stay stable when the path rotates.
		? `curl -s -A "${browserUserAgent}" "${pageUrl}" | grep -o '${token.slice(0, 24)}[A-Za-z0-9+/=]*' | base64 -d`
		: `curl -s -A "${browserUserAgent}" "${pageUrl}" | grep -F -o '${command.shown.slice(0, 40).replace(/'/g, "")}'`];
	for (const url of command.payloadUrls) {
		const payload = await payloadChecks(fetcher, url, downloaderUserAgent(command.interpreters));
		liveChecks.push(...payload.checks);
		reproduction.push(payload.reproduction[0]!);
	}
	const pageContext = contextAround(text, command);
	const dialog = dialogHolding(page.body.toString("utf8"), command);
	return {
		liveChecks,
		...(pageContext ? { pageContext } : {}),
		...(dialog ? { dialog } : {}),
		command: { shown: defangCommand(command.shown), decoded: command.layers.slice(1).map((layer) => defangCommand(layer.text)) },
		reproduction,
	};
}

export async function collectDecisionEvidence(params: {
	observedUrl: string;
	/** Set on payload-host reports: the User-Agent the host serves its file to. */
	reportedUserAgent?: string | null;
	caseUrl?: string;
	now?: () => Date;
	fetcher?: EvidenceFetcher;
}): Promise<DecisionEvidence> {
	const fetcher = params.fetcher ?? defaultFetcher;
	const checkedAt = (params.now ?? (() => new Date()))().toISOString();
	const measured = params.reportedUserAgent
		? await payloadChecks(fetcher, params.observedUrl, params.reportedUserAgent).then(({ checks, reproduction }) => ({ liveChecks: checks, reproduction }))
		: await pageEvidence(params.observedUrl, fetcher);
	const sha256 = measured.liveChecks.find((item) => item.as === "the command's own downloader" && item.sha256)?.sha256;
	return {
		checkedAt,
		...measured,
		references: [...(sha256 ? [payloadLookupUrl(sha256)] : []), ...(params.caseUrl ? [params.caseUrl] : [])],
	};
}

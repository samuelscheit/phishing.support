import MailAddressParser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import { Parser } from "htmlparser2";
import { type ChildNode, DomHandler, hasChildren, isTag, isText } from "domhandler";
import render from "dom-serializer";
import { type AddressObject, type Attachment, type ParsedMail, simpleParser } from "mailparser";

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseHtmlDom(html: string): Promise<ChildNode[]> {
	return new Promise((resolve, reject) => {
		const handler = new DomHandler((error, dom) => (error ? reject(error) : resolve(dom)));
		const parser = new Parser(handler);
		parser.write(html);
		parser.end();
	});
}

/** Depth-first search for the first node (document order) the predicate accepts. */
function searchRecursive(nodes: ChildNode[], predicate: (node: ChildNode) => boolean): ChildNode | null {
	for (const node of nodes) {
		if (predicate(node)) return node;
		if (hasChildren(node)) {
			const found = searchRecursive(node.children, predicate);
			if (found) return found;
		}
	}
	return null;
}

/**
 * Empties the text of `node`, of its previous siblings and, level by level, of
 * every ancestor and the siblings before it. Only the nodes themselves are
 * blanked, not the descendants of those siblings.
 */
function blankTextBefore(node: ChildNode): void {
	for (let level: ChildNode | null = node; level; level = level.parent) {
		for (let sibling: ChildNode | null = level; sibling; sibling = sibling.prev) {
			if ("data" in sibling) sibling.data = "";
		}
	}
}

function getNodeText(node: ChildNode): string {
	if ("data" in node) return node.data;
	if (hasChildren(node)) return node.children.map(getNodeText).join("");
	return "";
}

function elementHasClass(node: ChildNode, className: string): boolean {
	if (!isTag(node)) return false;
	const raw = node.attribs.class;
	if (!raw) return false;
	return raw.split(/\s+/g).includes(className);
}

function isTrivialHtmlNode(node: ChildNode): boolean {
	// Whitespace text node
	if (isText(node)) return node.data.trim().length === 0;
	if (!isTag(node)) return false;
	const name = node.name.toLowerCase();
	if (name === "br") return true;
	// Gmail sometimes inserts empty <u></u> between header and body
	if (name === "u") return getNodeText(node).trim().length === 0;
	return false;
}

function nextNonTrivialSibling(node: ChildNode | null): ChildNode | null {
	let cur = node;
	while (cur?.next) {
		cur = cur.next;
		if (!isTrivialHtmlNode(cur)) return cur;
	}
	return null;
}

function findClosestForwardHeaderContainer(node: ChildNode): ChildNode | null {
	for (let cur: ChildNode | null = node; cur; cur = cur.parent) {
		if (elementHasClass(cur, "gmail_attr")) return cur;
	}
	return null;
}

function findTopLevelAncestor(node: ChildNode): ChildNode {
	let cur = node;
	while (cur.parent) cur = cur.parent;
	return cur;
}

function nodeLooksLikeForwardHeaderLine(node: ChildNode): boolean {
	const text = getNodeText(node).replace(/\s+/g, " ").trim();
	if (!text) return false;
	// Header lines are usually short; this reduces false positives in long HTML bodies.
	if (text.length > 800) return false;
	return /^(from|von|to|an|subject|betreff|date|datum|sent|gesendet|cc|bcc)\s*:/i.test(text);
}

function renderNodes(nodes: ChildNode[]): string {
	return render(nodes, { decodeEntities: true });
}

/** Renders `start` and its following siblings, or null when there is no start node. */
function renderFromSibling(start: ChildNode | null): string | null {
	const siblings = start?.parent?.children;
	if (!start || !siblings) return null;
	const idx = siblings.indexOf(start);
	return idx >= 0 ? renderNodes(siblings.slice(idx)) : null;
}

function splitAfterForwardHeaders(nodes: ChildNode[], startAt: number): string | null {
	let i = startAt;
	let headerCount = 0;
	let sawAnyNonTrivial = false;

	for (; i < nodes.length; i++) {
		const n = nodes[i];
		if (isTrivialHtmlNode(n)) continue;
		sawAnyNonTrivial = true;
		if (nodeLooksLikeForwardHeaderLine(n)) {
			headerCount++;
			continue;
		}
		break;
	}

	// Require multiple header lines to be confident we're skipping a header block.
	if (!sawAnyNonTrivial) return null;
	if (headerCount < 2) return null;
	if (i >= nodes.length) return null;
	return renderNodes(nodes.slice(i));
}

function trySplitFromContainer(container: ChildNode, markerNode: ChildNode): string | null {
	if (!hasChildren(container) || container.children.length === 0) return null;
	const kids = container.children;

	// Find the topmost child within container that still contains markerNode
	let topChild = markerNode;
	let cur = markerNode;
	while (cur.parent && cur.parent !== container) cur = cur.parent;
	if (cur.parent === container) topChild = cur;

	const idx = kids.indexOf(topChild);
	if (idx < 0) return null;
	return splitAfterForwardHeaders(kids, idx);
}

function trySplitAfterMarkerInAncestors(markerNode: ChildNode): string | null {
	for (let cur: ChildNode | null = markerNode; cur; cur = cur.parent) {
		const siblings = cur.parent?.children;
		if (!siblings) continue;
		const idx = siblings.indexOf(cur);
		if (idx < 0) continue;
		// Case A: marker node itself is already a header line (e.g., first "From:" div)
		const splitAtMarker = splitAfterForwardHeaders(siblings, idx);
		if (splitAtMarker) return splitAtMarker;
		// Case B: marker node is "Begin forwarded message" and headers come after it
		const splitAfterMarker = splitAfterForwardHeaders(siblings, idx + 1);
		if (splitAfterMarker) return splitAfterMarker;
	}
	return null;
}

async function extractForwardedHtmlBody(parsed: Pick<ParsedMail, "html">): Promise<string> {
	const html = typeof parsed.html === "string" ? parsed.html : "";
	if (!html.trim()) return "";

	const forwardedMarkers = [
		/^-{2,}\s*Forwarded message\s*-{2,}$/i,
		/^Begin forwarded message:?$/i,
		/^[- ]*Original Message[- ]*$/i,
		/^(From|Von):\s*/i,
		/^(Gesendet|Sent):\s*/i,
		/^(Date|Datum):\s*/i,
		/^(To|An):\s*/i,
		/^(Subject|Betreff):\s*/i,
	];

	const dom = await parseHtmlDom(html);

	const markerNode = searchRecursive(dom, (node) =>
		normalizeNewlines(getNodeText(node))
			.split("\n")
			.some((line) => {
				const trimmed = line.trim();
				return trimmed !== "" && forwardedMarkers.some((re) => re.test(trimmed));
			}),
	);

	if (!markerNode) {
		// No obvious marker; return original HTML as-is.
		return html;
	}

	// Gmail forwarded messages: headers live in <div class="gmail_attr"> ... </div>, body follows.
	const gmailHeader = findClosestForwardHeaderContainer(markerNode);
	if (gmailHeader) {
		const afterGmailHeader = renderFromSibling(nextNonTrivialSibling(gmailHeader));
		if (afterGmailHeader !== null) return afterGmailHeader;
	}

	// iCloud / Apple Mail forwarding style: multiple "From/Subject/Date/To" divs, then the actual HTML body.
	// Try to skip that header block either at the root level or inside a container.
	const top = findTopLevelAncestor(markerNode);
	const rootIdx = dom.indexOf(top);
	if (rootIdx >= 0) {
		const split = splitAfterForwardHeaders(dom, rootIdx);
		if (split) return split;
	}
	const splitInContainer = trySplitFromContainer(top, markerNode);
	if (splitInContainer) return splitInContainer;
	const splitFromAncestors = trySplitAfterMarkerInAncestors(markerNode);
	if (splitFromAncestors) return splitFromAncestors;

	// Generic fallback: take the next meaningful sibling after the marker text node.
	let start = nextNonTrivialSibling(markerNode);
	let climb: ChildNode | null = markerNode;
	while (!start && climb?.parent) {
		start = nextNonTrivialSibling(climb);
		climb = climb.parent;
	}
	const afterMarker = renderFromSibling(start);
	if (afterMarker !== null) return afterMarker;

	// Last resort: return everything from the marker onward by blanking what came before.
	blankTextBefore(markerNode);
	return renderNodes(dom);
}

/**
 * The forwarded part of a plain-text body: everything from the first
 * forward/reply header on, or the unquoted text when it is mostly a quote.
 */
function extractForwardedText(plainText: string | undefined): string {
	const text = normalizeNewlines(plainText ?? "");
	if (!text.trim()) return "";

	const forwardedMarkers = [
		/^-{2,}\s*Forwarded message\s*-{2,}$/i,
		/^Begin forwarded message:?$/i,
		/^[- ]*Original Message[- ]*$/i,
		/^From:\s+/i,
		/^Von:\s+/i,
		/^Sent:\s+/i,
		/^Date:\s+/i,
		/^To:\s+/i,
		/^Subject:\s+/i,
	];

	const lines = text.split("\n");

	let startIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line) continue;
		const forwardMarker = forwardedMarkers.findIndex((re) => re.test(line));
		if (forwardMarker !== -1) {
			startIndex = i;

			// "Forwarded message" / "Begin forwarded message" lines are not part of the mail itself.
			if (forwardMarker === 0 || forwardMarker === 1) {
				startIndex++;
			}

			break;
		}
	}

	if (startIndex >= 0) {
		return lines.slice(startIndex).join("\n").trim();
	}

	const quoted = lines.map((l) => l.replace(/^\s*>\s?/, "")).filter((l) => l.trim().length > 0);

	// If it looks mostly like quoted content, prefer that
	const quotedCount = lines.filter((l) => /^\s*>/.test(l)).length;
	if (quotedCount >= Math.max(5, Math.floor(lines.length * 0.3))) {
		return quoted.join("\n").trim();
	}

	return text.trim();
}

function bufferToUtf8String(value: unknown): string {
	if (!value) return "";
	if (Buffer.isBuffer(value)) return value.toString("utf-8");
	if (value instanceof Uint8Array) return Buffer.from(value).toString("utf-8");
	if (typeof value === "string") return value;
	return "";
}

function looksLikeRfc822Message(raw: string): boolean {
	if (!raw) return false;
	// Heuristic: RFC822 message usually starts with a header block, then a blank line.
	// Avoid treating binary blobs as emails.
	if (raw.includes("\u0000")) return false;

	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const head = normalized.slice(0, 50_000);
	const lines = head.split("\n");

	let headerLines = 0;
	let sawBlankLine = false;
	let hasFrom = false;
	let hasTo = false;
	let hasSubject = false;
	let hasDate = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === "") {
			sawBlankLine = true;
			break;
		}

		// Folded header continuation
		if (/^\s+/.test(line)) continue;

		const m = /^([A-Za-z0-9-]{1,64}):\s*(.*)$/.exec(line);
		if (!m) return false;
		headerLines++;
		const key = m[1].toLowerCase();
		if (key === "from") hasFrom = true;
		if (key === "to" || key === "cc" || key === "bcc") hasTo = true;
		if (key === "subject") hasSubject = true;
		if (key === "date") hasDate = true;
	}

	if (!sawBlankLine) return false;
	if (headerLines < 3) return false;
	if (!hasFrom) return false;
	if (!hasTo && !hasSubject) return false;

	// Many legitimate messages won’t have Date, but it’s a useful additional signal.
	return hasDate || hasSubject || hasTo;
}

function parseMailAddressToObject(address: AddressObject | AddressObject[] | undefined): { address: string; name: string } | undefined {
	if (Array.isArray(address)) {
		return {
			address: address[0].value[0].address!,
			name: address[0].value[0].name || "",
		};
	} else if (typeof address === "object" && address.value.length > 0) {
		return {
			address: address.value[0].address!,
			name: address.value[0].name || "",
		};
	}
	return undefined;
}

/** A parsed attachment in the shape the composer rebuilds it from, keeping its MIME headers and raw content. */
function composerAttachment(attachment: Attachment): Mail.Attachment {
	const { contentDisposition } = attachment;
	return {
		...attachment,
		contentDisposition: contentDisposition === "attachment" || contentDisposition === "inline" ? contentDisposition : undefined,
		headers: Object.fromEntries(attachment.headers.entries()),
		raw: attachment.content,
	};
}

export async function extractEmlsFromIncomingMessage(parsed: ParsedMail): Promise<string[]> {
	const emls: string[] = [];

	for (const att of parsed.attachments ?? []) {
		const filename = (att.filename ?? "").toLowerCase();
		const contentType = (att.contentType ?? "").toLowerCase();
		const raw = bufferToUtf8String(att.content);
		if (!raw.trim()) continue;

		// Standard cases
		if (filename.endsWith(".eml") || contentType === "message/rfc822") {
			emls.push(raw);
			continue;
		}

		// Also allow other extensions (e.g. .txt) when the content itself appears to be an RFC822 message.
		// Some providers forward EMLs as "text/plain" attachments.
		if (!looksLikeRfc822Message(raw)) continue;

		try {
			const parsedAttachment = await simpleParser(raw, { skipTextToHtml: true });
			if (parsedAttachment.from || parsedAttachment.subject || parsedAttachment.text || parsedAttachment.html) {
				emls.push(raw);
			}
		} catch {
			// Not actually parseable as an email; ignore
		}
	}

	if (emls.length > 0) return emls;

	// No .eml attachments found → synthesize from forwarded/quoted message body
	try {
		const forwardedText = extractForwardedText(parsed.text);
		const forwardedHtml = await extractForwardedHtmlBody(parsed);

		const mail = await simpleParser(forwardedText);

		let from = mail.from;

		// A German client's "Von:" line; repeated, the parser hands a list, whose first sender counts.
		const vonHeader = mail.headers.get("von");
		const von = Array.isArray(vonHeader) ? vonHeader.filter((value): value is string => typeof value === "string").join(", ") : vonHeader;

		if (!from && typeof von === "string" && von) {
			const addresses = MailAddressParser(von, { flatten: true });
			const [address] = addresses;
			from = {
				text: address?.address || "",
				value: addresses,
				html: address?.address || "",
			};
		}

		const composed = await new MailComposer({
			from: parseMailAddressToObject(from),
			to: parseMailAddressToObject(parsed.from),
			bcc: parseMailAddressToObject(mail.bcc),
			cc: parseMailAddressToObject(mail.cc),
			subject: parsed.subject?.replace("Fwd:", "").replace("FW:", "").trim() || mail.subject || "(no subject)",
			text: mail.text || undefined,
			html: forwardedHtml || undefined,
			attachments: (mail.attachments || parsed.attachments).map(composerAttachment),
		})
			.compile()
			.build();

		return [composed.toString()];
	} catch {
		// Not a recognizable forward either; the caller treats it as no analyzable mail.
	}

	return [];
}

import sharp from "sharp";

/** Height of the browser-style address bar drawn above a captured page. */
const BAR_HEIGHT = 96;
const FONT = "DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif";
const MONO = "DejaVu Sans Mono, Liberation Mono, Menlo, Consolas, monospace";

export type AddressBarFacts = {
	/** The page's address, as the visitor's browser showed it. */
	url: string;
	/** When the page was captured, from this service's clock. */
	capturedAt: Date;
	/** How the browser reached the site, for example "Tor exit". */
	route: string;
	caseId: string;
	/** SHA-256 of the unmodified screenshot this bar is drawn above. */
	screenshotSha256: string;
};

function escapeXml(value: string): string {
	return value.replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]!);
}

/** Shorten a long URL in the middle so its host and its end both stay readable. */
function fitUrl(url: string, maximumCharacters: number): string {
	if (url.length <= maximumCharacters) return url;
	const keep = maximumCharacters - 1;
	return `${url.slice(0, Math.ceil(keep * 0.7))}…${url.slice(url.length - Math.floor(keep * 0.3))}`;
}

/** Drawn, not typed: an emoji would need a colour-emoji font the server does not have. */
const LOCK_ICON = `<g fill="none" stroke="#5f6368" stroke-width="2"><rect x="33" y="27" width="14" height="11" rx="2" fill="#5f6368"/><path d="M36 27v-4a4 4 0 0 1 8 0v4"/></g>`;
const WARNING_ICON = `<g><path d="M40 20l9 16h-18z" fill="#c5221f"/><rect x="39" y="25" width="2" height="6" fill="#fff"/><rect x="39" y="32" width="2" height="2" fill="#fff"/></g>`;

function addressBarSvg(width: number, facts: AddressBarFacts): string {
	const time = facts.capturedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
	const scheme = new URL(facts.url).protocol === "https:" ? "https" : "http";
	// About 9.6 px per character at 16 px; leave room for the lock and the margins.
	const urlCharacters = Math.max(24, Math.floor((width - 120) / 9.6));
	const details = `Captured ${time} (UTC) · via ${facts.route} · phishing.support case ${facts.caseId} · screenshot SHA-256 ${facts.screenshotSha256}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_HEIGHT}">
<rect width="${width}" height="${BAR_HEIGHT}" fill="#dee1e6"/>
<rect x="16" y="12" width="${width - 32}" height="40" rx="20" fill="#ffffff"/>
${scheme === "https" ? LOCK_ICON : WARNING_ICON}
<text x="62" y="38" font-family="${MONO}" font-size="16" fill="#202124">${escapeXml(fitUrl(facts.url, urlCharacters))}</text>
<text x="18" y="80" font-family="${FONT}" font-size="13" fill="#3c4043">${escapeXml(details)}</text>
</svg>`;
}

let textRenders: Promise<void> | undefined;

/**
 * Without a font, every glyph renders as the same empty box: a bar that
 * shows no URL is worse than none, so stamping refuses instead. Two strings
 * of different letters render identically only when glyphs are missing.
 */
function assertTextRenders(): Promise<void> {
	textRenders ??= (async () => {
		const render = (text: string) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="32"><rect width="160" height="32" fill="#fff"/><text x="4" y="22" font-family="${MONO}" font-size="16" fill="#000">${text}</text></svg>`)).raw().toBuffer();
		const [narrow, wide] = await Promise.all([render("iiii.://"), render("MWMW@#%W")]);
		if (narrow.equals(wide)) throw new Error("No font is installed: the address bar text would render as empty boxes.");
	})();
	return textRenders;
}

/**
 * The screenshot with a browser-style address bar drawn above it: the page's
 * URL, the capture time, the route, the case, and the SHA-256 of the
 * unmodified screenshot below, so the stamped copy names the raw file it
 * shows. The page pixels themselves are not changed.
 */
export async function stampAddressBar(screenshotPng: Buffer, facts: AddressBarFacts): Promise<Buffer> {
	await assertTextRenders();
	const { width, hasAlpha } = await sharp(screenshotPng).metadata();
	if (!width) throw new Error("The screenshot has no width.");
	const bar = await sharp(Buffer.from(addressBarSvg(width, facts))).png().toBuffer();
	const stamped = sharp(screenshotPng)
		.extend({ top: BAR_HEIGHT, background: "#dee1e6" })
		.composite([{ input: bar, top: 0, left: 0 }]);
	// Compositing adds an alpha channel; keep the screenshot's own channels so its pixels stay as captured.
	return (hasAlpha ? stamped : stamped.removeAlpha()).png().toBuffer();
}

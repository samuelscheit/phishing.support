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

function addressBarSvg(width: number, facts: AddressBarFacts): string {
	const time = facts.capturedAt.toISOString().replace(/\.\d{3}Z$/, "Z");
	const scheme = new URL(facts.url).protocol === "https:" ? "https" : "http";
	// About 9.6 px per character at 16 px; leave room for the lock and the margins.
	const urlCharacters = Math.max(24, Math.floor((width - 120) / 9.6));
	const details = `Captured ${time} (UTC) · via ${facts.route} · phishing.support case ${facts.caseId} · screenshot SHA-256 ${facts.screenshotSha256}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_HEIGHT}">
<rect width="${width}" height="${BAR_HEIGHT}" fill="#dee1e6"/>
<rect x="16" y="12" width="${width - 32}" height="40" rx="20" fill="#ffffff"/>
<text x="36" y="38" font-family="${FONT}" font-size="15" fill="${scheme === "https" ? "#5f6368" : "#c5221f"}">${scheme === "https" ? "🔒" : "⚠"}</text>
<text x="62" y="38" font-family="${MONO}" font-size="16" fill="#202124">${escapeXml(fitUrl(facts.url, urlCharacters))}</text>
<text x="18" y="80" font-family="${FONT}" font-size="13" fill="#3c4043">${escapeXml(details)}</text>
</svg>`;
}

/**
 * The screenshot with a browser-style address bar drawn above it: the page's
 * URL, the capture time, the route, the case, and the SHA-256 of the
 * unmodified screenshot below, so the stamped copy names the raw file it
 * shows. The page pixels themselves are not changed.
 */
export async function stampAddressBar(screenshotPng: Buffer, facts: AddressBarFacts): Promise<Buffer> {
	const { width, hasAlpha } = await sharp(screenshotPng).metadata();
	if (!width) throw new Error("The screenshot has no width.");
	const bar = await sharp(Buffer.from(addressBarSvg(width, facts))).png().toBuffer();
	const stamped = sharp(screenshotPng)
		.extend({ top: BAR_HEIGHT, background: "#dee1e6" })
		.composite([{ input: bar, top: 0, left: 0 }]);
	// Compositing adds an alpha channel; keep the screenshot's own channels so its pixels stay as captured.
	return (hasAlpha ? stamped : stamped.removeAlpha()).png().toBuffer();
}

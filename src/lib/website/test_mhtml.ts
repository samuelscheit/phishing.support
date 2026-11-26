/**
 * One gambling SEO page of a template: a card per game, each with the words
 * `words` picks, inside elements carrying `classes`; with <body>, 8 + 8 × cards tags.
 */
export const templatePage = (cards: number, words: (index: number) => string, classes: (index: number) => string = () => "card") =>
	`<main><h1>${words(-1)}</h1><ul>${Array.from({ length: cards }, (_, index) => `<li class="${classes(index)}"><h2>${words(index)}</h2><p>${words(index).repeat(3)}</p><a href="https://slinkku.click/${index}">Daftar</a></li>`).join("")}</ul></main>`;

/** Quoted-printable as Blink writes it: soft line breaks between encoded characters, never inside an `=XX` escape. */
function quotedPrintable(text: string): string {
	const tokens = [...Buffer.from(text).toString("latin1")].map((char) => (/[=\u0080-\u00ff]/.test(char) ? `=${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}` : char));
	const lines: string[] = [];
	let line = "";
	for (const token of tokens) {
		if (line.length + token.length > 75) {
			lines.push(`${line}=`);
			line = "";
		}
		line += token;
	}
	return [...lines, line].join("\r\n");
}

/** One kit page as Chrome stores it: quoted-printable HTML (or base64), a stylesheet part with a random id, an image. */
export const kitCapture = (host: string, cid: string, options: { head?: string; filler?: string; base64?: boolean; title?: string; body?: string } = {}) => {
	const body = options.body ?? `<a href="https://${host.toUpperCase()}/pay">Nạp xu giá rẻ</a><img src="https://cdn.${host.split(".").slice(-2).join(".")}/logo.png">${options.filler ?? "x".repeat(3_000)}`;
	const html = `<html><head><title>${options.title ?? "Nạp xu"}</title><link rel="stylesheet" href="cid:css-${cid}@mhtml.blink">${options.head ?? ""}</head><body class="app">${body}</body></html>`;
	const encoded = options.base64
		? Buffer.from(html).toString("base64").replace(/.{76}/g, "$&\r\n")
		: quotedPrintable(html);
	return Buffer.from([
		"From: <Saved by Blink>",
		`Snapshot-Content-Location: https://${host}/`,
		"MIME-Version: 1.0",
		'Content-Type: multipart/related; type="text/html"; boundary="B"',
		"",
		"--B",
		"Content-Type: text/html",
		`Content-ID: <frame-${cid}@mhtml.blink>`,
		`Content-Transfer-Encoding: ${options.base64 ? "base64" : "quoted-printable"}`,
		`Content-Location: https://${host}/`,
		"",
		encoded,
		"--B",
		"Content-Type: text/css",
		"Content-Transfer-Encoding: quoted-printable",
		`Content-Location: cid:css-${cid}@mhtml.blink`,
		"",
		"body { color: red; }",
		"--B--",
		"",
	].join("\r\n"), "latin1");
};

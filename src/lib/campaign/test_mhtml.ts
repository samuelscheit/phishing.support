/** One kit page as Chrome stores it: quoted-printable HTML (or base64), a stylesheet part with a random id, an image. */
export const kitCapture = (host: string, cid: string, options: { head?: string; filler?: string; base64?: boolean } = {}) => {
	const html = `<html><head><link rel="stylesheet" href="cid:css-${cid}@mhtml.blink">${options.head ?? ""}</head><body class="app"><a href="https://${host.toUpperCase()}/pay">Nạp xu giá rẻ</a><img src="https://cdn.${host.split(".").slice(-2).join(".")}/logo.png">${options.filler ?? "x".repeat(3_000)}</body></html>`;
	const encoded = options.base64
		? Buffer.from(html).toString("base64").replace(/.{76}/g, "$&\r\n")
		: Buffer.from(html).toString("latin1").replace(/[=\u0080-\u00ff]/g, (char) => `=${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).replace(/.{70}/g, "$&=\r\n");
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

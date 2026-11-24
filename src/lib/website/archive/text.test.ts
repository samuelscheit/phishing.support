import { expect, test } from "bun:test";

import { capturedDocumentContent } from "./text";

test("captured page text includes what visitors read from attributes, but never hidden or entered values", () => {
	const { html, text } = capturedDocumentContent(`<html><head><title>Microsoft</title><script>steal()</script></head><body>
<img src="logo.png" alt="Microsoft logo"><h1>Sign in</h1>
<input type="email" placeholder="Email, phone, or Skype"><input type="password" aria-label="Password">
<input type="hidden" name="token" value="session-secret"><input type="text" name="prefill" value="victim@example.test">
<input type="submit" value="Next"><div contenteditable aria-placeholder="Code"></div>
</body></html>`);

	for (const visible of ["Sign in", "Microsoft logo", "Email, phone, or Skype", "Password", "Next", "Code"]) {
		expect(text.split("\n")).toContain(visible);
	}
	expect(text).not.toContain("session-secret");
	expect(text).not.toContain("victim@example.test");
	expect(html).not.toContain("<script");
	expect(html).not.toContain("<img");
});

test("captured page text keeps attribute captions where a visitor reads them", () => {
	// A kit that labels its fields only with placeholders, quoted by the classifier across heading and fields.
	const { html, text } = capturedDocumentContent(`<html><body><form>
<p><img alt="Microsoft Logo"></p><h1>Iniciar sesión</h1><p>Verificación Microsoft</p>
<input type="email" placeholder="Correo electrónico, teléfono o Skype"><input type="text" placeholder="Contraseña de correo">
<a href="#">¿No puede acceder a su cuenta?</a><button aria-label="Siguiente">Siguiente</button>
</form></body></html>`);

	expect(text).toContain("Microsoft Logo\nIniciar sesión\nVerificación Microsoft\nCorreo electrónico, teléfono o Skype\nContraseña de correo\n¿No puede acceder a su cuenta?");
	// A caption equal to the element's own text is not repeated.
	expect(text.match(/Siguiente/g)).toHaveLength(1);
	expect(html).not.toContain("<img");
	expect(html.match(/Contraseña de correo/g)).toHaveLength(1);
});

test("captured page text leaves out filler a visitor cannot see, which kits use to drown out their form", () => {
	const filler = "Family photos stay in the local archive until the next backup.";
	const { html, text } = capturedDocumentContent(`<!DOCTYPE html><html><body>
<i style="font-size:0!important;opacity:0!important;position:absolute!important">${filler}</i>
<p style="color:transparent; font-size: 0px">${filler}</p><span hidden>${filler}</span><!-- ${filler} -->
<div style="display:none">${filler}</div><div style="visibility: hidden">${filler}</div>
<h1>Sign in with Apple Account</h1><input placeholder="Email or Phone Number">
<p style="opacity:0.5">Forgot password?</p><p style="font-size:0.9em">Keep me signed in</p>
</body></html>`);

	expect(text).toBe("Sign in with Apple Account\nEmail or Phone Number\nForgot password?\nKeep me signed in");
	expect(html).not.toContain(filler);
});

test("captured page text shows each frame's document where the frame stands, however deep, but not hidden frames", () => {
	// How mhtml-to-html leaves a Google Sites page embedding an Apps Script kit: each frame's document in its srcdoc.
	const kit = `<!DOCTYPE html><html><head><title>Security Verification</title></head><body><h1>Sign in</h1><input type="password" aria-label="Password"></body></html>`;
	const sandbox = `<html><body><iframe id="userHtmlFrame" srcdoc="${kit.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe></body></html>`;
	const page = `<!DOCTYPE html><html><head><title>Revert apps</title></head><body><h1>Embedded Files</h1>
<iframe aria-label="Apps Script" srcdoc="${sandbox.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>
<iframe hidden srcdoc="<p>tracking pixel frame</p>"></iframe><iframe style="display:none" srcdoc="<p>invisible frame</p>"></iframe>
<p>Page updated</p></body></html>`;

	const { html, text } = capturedDocumentContent(page);

	expect(text).toBe("Revert apps\nRevert apps\nEmbedded Files\nSign in\nPassword\nPage updated");
	expect(html).not.toContain("<iframe");
	expect(html).not.toContain("srcdoc");
	expect(html).toContain('type="password"');
});
